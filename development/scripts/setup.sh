#!/bin/bash

echo "TicketBottle Setup Script"
echo "========================="

# Create envs directory if not exists
mkdir -p envs

# Detect external IP
VM_IP=$(curl -s ifconfig.me)
echo "Detected External IP: $VM_IP"

# Update payment service HOST environment variable
PAYMENT_ENV_FILE="envs/payment.env"

if [ -f "$PAYMENT_ENV_FILE" ]; then
    if grep -q "^HOST=" "$PAYMENT_ENV_FILE"; then
        sed -i.bak "s|^HOST=.*|HOST=$VM_IP|" "$PAYMENT_ENV_FILE"
    else
        echo "HOST=$VM_IP" >> "$PAYMENT_ENV_FILE"
    fi
else
    echo "Warning: $PAYMENT_ENV_FILE not found. Creating new file."
    echo "HOST=$VM_IP" > "$PAYMENT_ENV_FILE"
fi

# Configure Nginx reverse proxy
echo "Configuring Nginx..."

sudo tee /etc/nginx/sites-available/payment-webhook > /dev/null <<EOF
server {
    listen 80;
    server_name _;

    location /payment/webhook {
        proxy_pass http://localhost:8085/webhook;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        client_max_body_size 10M;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/payment-webhook /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl restart nginx

# Pull latest Docker images
echo "Pulling Docker images..."
docker-compose pull

# Start infrastructure services
echo "Starting infrastructure services..."
docker-compose up -d redis postgres-inventory postgres-event postgres-payment mongo-order zookeeper kafka postgres-temporal elasticsearch-temporal temporal

# Wait for infrastructure to be ready
echo "Waiting for infrastructure (30 seconds)..."
sleep 30

# Start application services
echo "Starting application services..."
docker-compose up -d

# Show service status
echo ""
echo "Service Status:"
docker-compose ps

echo ""
echo "Setup complete!"
echo ""
echo "Access Points:"
echo "  - API Gateway: http://localhost:3000"
echo ""
echo "View logs: docker-compose logs -f"