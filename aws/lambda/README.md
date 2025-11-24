# TicketBottle Lambda Functions

AWS Lambda functions for TicketBottle V2 auxiliary workloads.

## Functions

| Function | Trigger | Description |
|----------|---------|-------------|
| `payment-webhook-handler` | API Gateway | Handles ZaloPay/PayOS payment callbacks |
| `outbox-processor` | EventBridge (1 min) | Polls outbox table, publishes to Kafka |
| `outbox-cleanup` | EventBridge (daily) | Cleanup old events, monitor failures |
| `email-sender` | SQS (from Kafka) | Sends transactional emails via SES |
| `pdf-generator` | SQS (from Kafka) | Generates ticket PDFs, stores in S3 |

## Architecture

```
                     +------------------+
                     |   API Gateway    |
                     +--------+---------+
                              |
                              v
+----------------+   +--------+---------+
| Payment        |   | payment-webhook- |
| Providers      +-->| handler          |
| (ZaloPay/PayOS)|   +--------+---------+
+----------------+            |
                              v
                     +--------+---------+
                     |  Aurora Outbox   |
                     +--------+---------+
                              |
              +---------------+---------------+
              |                               |
              v                               v
     +--------+---------+            +--------+---------+
     | outbox-processor |            | outbox-cleanup   |
     | (every 1 min)    |            | (daily 2 AM)     |
     +--------+---------+            +------------------+
              |
              v
     +--------+---------+
     |   Kafka / MSK    |
     +--------+---------+
              |
     +--------+---------+
     | EventBridge Pipes|
     +--------+---------+
              |
     +--------+--------+
     |                 |
     v                 v
+----+----+     +------+------+
| email-  |     | pdf-        |
| sender  |     | generator   |
+---------+     +------+------+
     |                 |
     v                 v
+----+----+     +------+------+
|   SES   |     |     S3      |
+---------+     +-------------+
```

## Environment Variables

### payment-webhook-handler
- `DATABASE_URL` - Aurora PostgreSQL connection string
- `ZALOPAY_KEY2` - ZaloPay MAC verification key
- `PAYOS_CHECKSUM_KEY` - PayOS signature verification key

### outbox-processor
- `DATABASE_URL` - Aurora PostgreSQL connection string
- `KAFKA_BROKERS` - Comma-separated broker addresses
- `KAFKA_SSL` - Enable SSL (true/false)
- `KAFKA_SASL_USERNAME` - SASL username (optional)
- `KAFKA_SASL_PASSWORD` - SASL password (optional)
- `KAFKA_TOPIC_PAYMENT_COMPLETED` - Topic name
- `KAFKA_TOPIC_PAYMENT_FAILED` - Topic name

### outbox-cleanup
- `DATABASE_URL` - Aurora PostgreSQL connection string
- `RETENTION_DAYS` - Days to retain published events (default: 7)
- `CLOUDWATCH_NAMESPACE` - Metrics namespace

### email-sender
- `SES_FROM_EMAIL` - Sender email address
- `SES_REGION` - AWS region for SES
- `S3_BUCKET_TICKETS` - S3 bucket for ticket PDFs

### pdf-generator
- `S3_BUCKET_TICKETS` - S3 bucket for ticket PDFs
- `QR_CODE_BASE_URL` - Base URL for QR validation

## Development

```bash
# Install dependencies
npm install

# Build all functions
npm run build

# Package for deployment
npm run package
```

## Deployment

Functions are deployed via Terraform. See `aws/terraform/lambda.tf`.

### IAM Permissions

Each function has least-privilege IAM roles:

- **payment-webhook-handler**: Aurora read/write, Secrets Manager read
- **outbox-processor**: Aurora read/write, MSK produce
- **outbox-cleanup**: Aurora delete, CloudWatch publish
- **email-sender**: SES send, S3 read
- **pdf-generator**: S3 write

### VPC Configuration

All functions requiring database access run in the same VPC as EKS:
- Private subnets with NAT Gateway
- Security groups allowing Aurora/MSK access

## Monitoring

- CloudWatch Logs: Each function logs to `/aws/lambda/{function-name}`
- CloudWatch Metrics: Custom metrics in `TicketBottle/Lambda` namespace
- X-Ray: Tracing enabled for all functions
- Alarms: Set up for error rates and duration thresholds
