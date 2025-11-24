# TicketBottle V2 - AWS Architecture

## System Overview

TicketBottle is a high-performance ticket selling platform built on microservices architecture. This document describes the AWS deployment architecture using a **hybrid approach**: EKS for core services and Lambda for auxiliary functions.

---

## High-Level Architecture

```
                                     INTERNET
                                         |
                                    +----v----+
                                    | Route53 |
                                    +---------+
                                         |
                    +--------------------+--------------------+
                    |                                         |
             us-east-1 (Primary)                   ap-southeast-1 (Secondary)
                    |
    +---------------+---------------+
    |                               |
    |           AWS WAF             |
    |               |               |
    |    +----------v----------+    |
    |    |         ALB         |    |
    |    +----------+----------+    |
    |               |               |
    |    +----------v----------+    |
    |    |                     |    |
    |    |     AMAZON EKS      |    |
    |    |                     |    |
    |    |  +---------------+  |    |
    |    |  | API Gateway   |  |    |
    |    |  | (NestJS:3000) |  |    |
    |    |  +-------+-------+  |    |
    |    |          |          |    |
    |    |    +-----v-----+    |    |
    |    |    |   gRPC    |    |    |
    |    |    | Services  |    |    |
    |    |    +-----------+    |    |
    |    |    | User      |    |    |
    |    |    | Event     |    |    |
    |    |    | Payment   |    |    |
    |    |    | Inventory |    |    |
    |    |    | Order     |    |    |
    |    |    | Waitroom  |    |    |
    |    |    +-----------+    |    |
    |    |                     |    |
    |    |  +---------------+  |    |
    |    |  | Kafka(3)      |  |    |
    |    |  | Temporal      |  |    |
    |    |  | Prometheus    |  |    |
    |    |  +---------------+  |    |
    |    +---------------------+    |
    |               |               |
    +-------+-------+-------+-------+
            |       |       |
            v       v       v
    +-------+  +----+----+  +-------+
    | Aurora|  |DynamoDB |  | Redis |
    |  v2   |  | (Order) |  |(Queue)|
    +-------+  +---------+  +-------+

    +-------------------------------+
    |       Lambda Functions        |
    |  +--------+ +------+ +-----+  |
    |  |Webhook | |Email | | PDF |  |
    |  +--------+ +------+ +-----+  |
    +-------------------------------+
                  VPC
```

---

## Core Services (EKS)

### Service Catalog

| Service | Language | Port | Protocol | Database | Description |
|---------|----------|------|----------|----------|-------------|
| **API Gateway** | NestJS | 3000 | HTTP/REST | - | Entry point, auth, rate limiting |
| **User Service** | NestJS | 50051 | gRPC | Aurora | User management, authentication |
| **Event Service** | NestJS | 50053 | gRPC | Aurora | Event lifecycle, CQRS |
| **Inventory Service** | Go | 50054 | gRPC | Aurora | Ticket inventory, pessimistic locking |
| **Order Service** | Go | 50055 | gRPC | DynamoDB | Order management, Temporal sagas |
| **Payment Service** | NestJS | 50052 | gRPC | Aurora | Multi-provider payments, outbox |
| **Waitroom Service** | Go | 50056 | gRPC | Redis | Queue management, real-time streaming |

### Why EKS (Not Serverless)

| Requirement | EKS Support | Lambda Limitation |
|-------------|-------------|-------------------|
| gRPC Protocol | Native | Not supported |
| Persistent Connections | Yes | Stateless |
| Real-time Streaming | gRPC streams | Polling only |
| Pessimistic Locking | DB connection pools | Connection per invocation |
| Temporal Workflows | Long-running pods | 15-min timeout |

---

## Auxiliary Services (Lambda)

### Function Catalog

| Function | Trigger | Purpose | Concurrency |
|----------|---------|---------|-------------|
| **payment-webhook-handler** | API Gateway (POST) | ZaloPay/PayOS callbacks | 100 |
| **outbox-processor** | EventBridge (1 min) | Poll outbox, publish to Kafka | 1 |
| **outbox-cleanup** | EventBridge (daily 2AM) | Cleanup old events, monitoring | 1 |
| **email-sender** | SQS (from Kafka) | Order confirmation, tickets | 50 |
| **pdf-generator** | SQS (from Kafka) | Generate ticket PDFs with QR | 20 |

### Lambda Architecture

```
+-------------------+     +------------------+
| Payment Providers |     |   API Gateway    |
| (ZaloPay, PayOS)  |---->| POST /webhook/*  |
+-------------------+     +--------+---------+
                                   |
                                   v
                          +--------+---------+
                          | payment-webhook- |
                          | handler          |
                          +--------+---------+
                                   |
                                   v
                          +--------+---------+
                          |  Aurora Outbox   |
                          |  (Payment DB)    |
                          +--------+---------+
                                   |
              +--------------------+--------------------+
              |                                         |
+-------------v-------------+              +------------v-----------+
| EventBridge (1 min)       |              | EventBridge (daily)    |
+-------------+-------------+              +------------+-----------+
              |                                         |
              v                                         v
+-------------+-------------+              +------------+-----------+
| outbox-processor          |              | outbox-cleanup         |
| - Poll unpublished events |              | - Delete old events    |
| - Publish to Kafka        |              | - Monitor failures     |
| - Mark as published       |              | - CloudWatch metrics   |
+-------------+-------------+              +------------------------+
              |
              v
+-------------+-------------+
|    Kafka / MSK            |
| payment.completed         |
| payment.failed            |
+-------------+-------------+
              |
+-------------+-------------+
| EventBridge Pipes         |
| (Kafka -> SQS)            |
+-------------+-------------+
              |
     +--------+--------+
     |                 |
     v                 v
+----+----+      +-----+-----+
| email-  |      | pdf-      |
| sender  |      | generator |
+---------+      +-----------+
     |                 |
     v                 v
+----+----+      +-----+-----+
|   SES   |      |    S3     |
+---------+      +-----------+
```

### Lambda Configuration

| Function | Runtime | Memory | Timeout | VPC |
|----------|---------|--------|---------|-----|
| payment-webhook-handler | Node.js 20 | 256 MB | 30s | Yes (Aurora) |
| outbox-processor | Node.js 20 | 256 MB | 60s | Yes (Aurora, MSK) |
| outbox-cleanup | Node.js 20 | 256 MB | 120s | Yes (Aurora) |
| email-sender | Node.js 20 | 256 MB | 30s | No |
| pdf-generator | Node.js 20 | 512 MB | 300s | No |

### Code Location

All Lambda functions are implemented in TypeScript:

```
aws/lambda/
+-- payment-webhook-handler/
|   +-- index.ts          # Webhook verification and handling
+-- outbox-processor/
|   +-- index.ts          # Outbox polling and Kafka publishing
+-- outbox-cleanup/
|   +-- index.ts          # Cleanup and monitoring
+-- email-sender/
|   +-- index.ts          # SES email delivery
+-- pdf-generator/
|   +-- index.ts          # PDFKit + QR code generation
+-- package.json          # Shared dependencies
+-- tsconfig.json         # TypeScript config
+-- README.md             # Documentation
```

---

## Data Architecture

### Database Distribution

```
+------------------------------------------------------------------+
|                      Aurora Serverless v2                         |
|                    (PostgreSQL 15 Compatible)                     |
|                                                                   |
|  +-----------------+  +-----------------+  +-----------------+    |
|  | users           |  | events          |  | payments        |    |
|  | user_roles      |  | venues          |  | transactions    |    |
|  | sessions        |  | ticket_types    |  | outbox          |    |
|  +-----------------+  +-----------------+  +-----------------+    |
|                                                                   |
|  +-------------------------------------------------------------+  |
|  |                     Inventory Schema                         |  |
|  |  ticket_classes | reservations | inventory_snapshots         |  |
|  |  (pessimistic locking with SELECT FOR UPDATE)                |  |
|  +-------------------------------------------------------------+  |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
|                           DynamoDB                                |
|                                                                   |
|  Table: ticketbottle-orders                                       |
|  +-- PK: order_id (String)                                        |
|  +-- GSI: user_id-index (user_id, created_at)                     |
|  +-- GSI: event_id-index (event_id, status)                       |
|                                                                   |
|  Features: Global Tables (multi-region), On-demand capacity       |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
|                       ElastiCache Redis                           |
|                                                                   |
|  Data Structures:                                                 |
|  +-- ZSET: waitroom:{event_id}         (queue positions)          |
|  +-- HASH: session:{session_id}        (session data)             |
|  +-- STRING: token:{user_id}           (JWT tokens)               |
|  +-- PUBSUB: position:{event_id}       (real-time updates)        |
|                                                                   |
|  Configuration: 2-node replication, TLS enabled                   |
+------------------------------------------------------------------+
```

### Data Flow

```
User --> API GW --> Waitroom --> Redis (ZSET)
                        |
                        v
                   Inventory
               (SELECT FOR UPDATE)
                        |
                        v
                     Order ---------> DynamoDB
                   (Temporal)
                        |
                        v
                    Payment -------> ZaloPay/PayOS
                   (webhook) <-------
                        |
                        v
                     Kafka
                  (order.paid)
                        |
         +--------------+--------------+
         |              |              |
         v              v              v
   Email Lambda   PDF Lambda   Inventory Confirm
  (confirmation)  (ticket.pdf)   (update sold)
```

---

## Network Architecture

### VPC Design

```
+------------------------------------------------------------------+
|                       VPC: 10.0.0.0/16                            |
|                                                                   |
|  +-------------------------------------------------------------+  |
|  |                   Availability Zone A                        |  |
|  |                                                              |  |
|  |  +------------------+    +------------------+                |  |
|  |  |  Public Subnet   |    |  Private Subnet  |                |  |
|  |  |  10.0.1.0/24     |    |  10.0.10.0/24    |                |  |
|  |  |                  |    |                  |                |  |
|  |  |  - NAT Gateway   |    |  - EKS Nodes     |                |  |
|  |  |  - ALB           |    |  - Aurora        |                |  |
|  |  |                  |    |  - ElastiCache   |                |  |
|  |  +------------------+    +------------------+                |  |
|  +-------------------------------------------------------------+  |
|                                                                   |
|  +-------------------------------------------------------------+  |
|  |                   Availability Zone B                        |  |
|  |  +------------------+    +------------------+                |  |
|  |  |  Public Subnet   |    |  Private Subnet  |                |  |
|  |  |  10.0.2.0/24     |    |  10.0.20.0/24    |                |  |
|  |  +------------------+    +------------------+                |  |
|  +-------------------------------------------------------------+  |
|                                                                   |
|  +-------------------------------------------------------------+  |
|  |                   Availability Zone C                        |  |
|  |  +------------------+    +------------------+                |  |
|  |  |  Public Subnet   |    |  Private Subnet  |                |  |
|  |  |  10.0.3.0/24     |    |  10.0.30.0/24    |                |  |
|  |  +------------------+    +------------------+                |  |
|  +-------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

### Security Groups

| Security Group | Inbound | Source |
|----------------|---------|--------|
| `sg-alb` | 443 (HTTPS) | 0.0.0.0/0 |
| `sg-eks-nodes` | All | sg-alb, sg-eks-nodes |
| `sg-aurora` | 5432 | sg-eks-nodes, sg-lambda |
| `sg-redis` | 6379 | sg-eks-nodes |
| `sg-lambda` | - | Outbound only |

### Network Policies (Kubernetes)

```yaml
# Only API Gateway can reach User Service
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: user-service-ingress
spec:
  podSelector:
    matchLabels:
      app: user-service
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api-gateway
      ports:
        - protocol: TCP
          port: 50051
```

---

## Security Architecture

### Identity & Access

```
+------------------------------------------------------------------+
|                           IAM Roles                               |
|                                                                   |
|  +-------------------------------------------------------------+  |
|  |                 IRSA (Service Accounts)                      |  |
|  |                                                              |  |
|  |  order-service-sa --------> DynamoDB:orders (read/write)     |  |
|  |  payment-service-sa ------> Secrets Manager (read)           |  |
|  |  all-services-sa ---------> CloudWatch Logs (write)          |  |
|  |                             X-Ray (write)                    |  |
|  +-------------------------------------------------------------+  |
|                                                                   |
|  +-------------------------------------------------------------+  |
|  |                 Lambda Execution Roles                       |  |
|  |                                                              |  |
|  |  lambda-webhook-role -----> VPC (execute-api)                |  |
|  |  lambda-email-role -------> SES (send)                       |  |
|  |  lambda-pdf-role ---------> S3 (write)                       |  |
|  +-------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

### Secrets Management

| Secret | Service | Rotation |
|--------|---------|----------|
| `aurora-credentials` | Aurora | 30 days |
| `redis-auth-token` | ElastiCache | Manual |
| `jwt-secret` | API Gateway | Manual |
| `zalopay-credentials` | Payment | Manual |
| `payos-credentials` | Payment | Manual |

### Encryption

| Layer | Method |
|-------|--------|
| Data at Rest | KMS (Aurora, DynamoDB, S3, EBS) |
| Data in Transit | TLS 1.2+ (ALB, gRPC, Redis) |
| Secrets | AWS Secrets Manager |
| Container Images | ECR scan on push |

---

## Event Streaming

### Kafka Topics

| Topic | Partitions | Producers | Consumers |
|-------|------------|-----------|-----------|
| `order.created` | 3 | Order Service | Analytics |
| `order.paid` | 3 | Payment Service | Order, Email, PDF |
| `payment.initiated` | 3 | Order Service | Payment |
| `inventory.reserved` | 3 | Inventory | Order |
| `queue.position` | 3 | Waitroom | - |

### EventBridge Integration

```
Kafka (EKS) --> Kafka Connect --> EventBridge
                  (S3 Sink)           |
                               +------+------+
                               |      |      |
                               v      v      v
                            Email   PDF   Analytics
                           Lambda  Lambda  Lambda
```

---

## Multi-Region Strategy

### Active-Passive Architecture

```
                        Route 53
                (Geolocation + Failover)
                           |
          +----------------+----------------+
          |                                 |
          v                                 v
  +---------------+                 +---------------+
  |  us-east-1    |                 | ap-southeast-1|
  |  (PRIMARY)    |                 |  (STANDBY)    |
  |               |                 |               |
  | EKS: Active   |                 | EKS: Scaled 0 |
  | Aurora: Writer| <-------------> | Aurora: Reader|
  | DynamoDB: Act | <-------------> | DynamoDB: Rep |
  | Redis: Primary| <-------------> | Redis: Replica|
  +---------------+                 +---------------+
          |                                 |
          |     +---------------------+     |
          +---->| DynamoDB Global Tbl |<----+
                | Aurora Global DB    |
                | ElastiCache Global  |
                +---------------------+
```

### Failover Metrics

| Metric | Target |
|--------|--------|
| RTO (Recovery Time Objective) | < 5 minutes |
| RPO (Recovery Point Objective) | < 1 minute |
| Replication Lag (DynamoDB) | < 1 second |
| Replication Lag (Aurora) | < 100ms |

---

## Observability

### Monitoring Stack

```
+------------------------------------------------------------------+
|                          CloudWatch                               |
|                                                                   |
|  Container Insights:                                              |
|  - EKS cluster metrics                                            |
|  - Pod CPU/Memory                                                 |
|  - Node utilization                                               |
|                                                                   |
|  Log Groups:                                                      |
|  - /aws/eks/ticketbottle/cluster                                  |
|  - /aws/lambda/payment-webhook                                    |
|  - /aws/rds/cluster/ticketbottle/postgresql                       |
|                                                                   |
|  Alarms:                                                          |
|  - API Gateway 5xx > 1%                                           |
|  - Aurora connections > 80%                                       |
|  - Lambda errors > 5%                                             |
|  - DynamoDB throttling                                            |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
|                     Prometheus + Grafana (on EKS)                 |
|                                                                   |
|  Dashboards:                                                      |
|  - Kubernetes cluster health                                      |
|  - Kafka broker metrics (JMX exporter)                            |
|  - gRPC latency histograms                                        |
|  - Redis operations/second                                        |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
|                          AWS X-Ray                                |
|                                                                   |
|  Tracing:                                                         |
|  - End-to-end request flow                                        |
|  - Service map visualization                                      |
|  - Latency breakdown by service                                   |
|  - Error correlation                                              |
+------------------------------------------------------------------+
```

### Key Metrics

| Service | Metric | Threshold |
|---------|--------|-----------|
| API Gateway | Request latency p99 | < 500ms |
| Inventory | Lock acquisition time | < 50ms |
| Waitroom | Position update latency | < 100ms |
| Order | Saga completion time | < 30s |
| Payment | Webhook processing | < 5s |

---

## Deployment Pipeline

```
GitHub -----> GitHub Actions -----> ECR
(push/PR)     (build, test)      (images)
                                     |
                                     v
                                  ArgoCD
                               (GitOps sync)
                                     |
              +----------------------+----------------------+
              |                      |                      |
              v                      v                      v
          EKS Dev              EKS Staging              EKS Prod
```

### Deployment Strategy

- **EKS Services**: Rolling update (25% max unavailable)
- **Lambda**: Blue/green with traffic shifting
- **Database**: Blue/green for Aurora, zero-downtime for DynamoDB

---

## Cost Optimization

### Resource Sizing

| Resource | Dev | Staging | Production |
|----------|-----|---------|------------|
| EKS Nodes | 2x t3.medium | 3x t3.medium | 3x t3.large (spot) |
| Aurora ACU | 0.5-2 | 1-4 | 2-16 |
| Redis | cache.t3.micro | cache.t3.small | cache.t3.small (2 nodes) |
| Lambda | 256MB | 256MB | 512MB |

### Cost Controls

- **Karpenter**: Auto-scale with spot instances (70% savings)
- **Aurora Serverless**: Scale to zero in dev/staging
- **Reserved Capacity**: 1-year Savings Plans for production
- **S3 Lifecycle**: Archive logs after 30 days

---

## Disaster Recovery

### Backup Strategy

| Resource | Backup | Retention | Recovery |
|----------|--------|-----------|----------|
| Aurora | Automated snapshots | 7 days | Point-in-time |
| DynamoDB | Point-in-time recovery | 35 days | Any second |
| Redis | Daily snapshots | 7 days | Restore from snapshot |
| Kafka | S3 archival | 90 days | Replay from S3 |
| EKS | Velero backups | 30 days | Full cluster restore |

### Runbooks

1. **Aurora Failover**: Automatic (Multi-AZ)
2. **Region Failover**: Route 53 health check -> DNS update
3. **Kafka Broker Loss**: Strimzi auto-recovery
4. **Pod Crash**: Kubernetes self-healing (restart)

---

## References

- [Amazon EKS Best Practices](https://aws.github.io/aws-eks-best-practices/)
- [Aurora Serverless v2](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html)
- [DynamoDB Best Practices](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html)
- [Lambda in VPC](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html)
- [Strimzi Kafka Operator](https://strimzi.io/documentation/)

---

*For deployment timeline and implementation phases, see [PLAN.md](./PLAN.md).*
