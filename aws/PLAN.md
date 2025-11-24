# AWS Deployment Plan - TicketBottle V2

## Overview

**Timeline**: 3-4 weeks
**Team**: 4 members
**Architecture**: Hybrid (EKS + Lambda)
**Target Regions**: us-east-1 (primary), ap-southeast-1 (secondary)

---

## Architecture Decision Summary

### Core Services (EKS)
All 7 microservices run on Amazon EKS due to:
- gRPC protocol requirements (persistent connections)
- Real-time streaming (Waitroom position updates)
- Pessimistic locking (Inventory `SELECT FOR UPDATE`)
- Stateful workflows (Order service with Temporal)

### Auxiliary Functions (Lambda)
Serverless for event-driven, stateless workloads:
- Payment webhooks (ZaloPay, PayOS callbacks)
- Email notifications (order confirmation, tickets)
- PDF generation (ticket documents)
- Scheduled jobs (cleanup, analytics)

---

## Service-to-AWS Mapping

| Service | Compute | Database | Why |
|---------|---------|----------|-----|
| **API Gateway** | EKS | - | gRPC client management, rate limiting |
| **User Service** | EKS | Aurora Serverless v2 | Connection pooling, Prisma ORM |
| **Event Service** | EKS | Aurora Serverless v2 | CQRS patterns, PostgreSQL features |
| **Inventory Service** | EKS | Aurora Serverless v2 | Pessimistic locking (`SELECT FOR UPDATE`) |
| **Order Service** | EKS | DynamoDB | Document storage, Temporal workflows |
| **Payment Service** | EKS | Aurora Serverless v2 | Outbox pattern, background workers |
| **Waitroom Service** | EKS | ElastiCache Redis | Real-time streaming, ZRANK position |
| **Payment Webhooks** | Lambda | - | Stateless, event-driven |
| **Email Sender** | Lambda + SES | - | Triggered by Kafka events |
| **PDF Generator** | Lambda + S3 | - | On-demand ticket generation |
| **Cleanup Jobs** | Lambda + EventBridge | - | Scheduled (every 5 min) |

---

## Database Strategy

| Database | Services | Migration Complexity |
|----------|----------|---------------------|
| **Aurora Serverless v2** | User, Event, Payment, Inventory | LOW - Connection string only |
| **DynamoDB** | Order | MEDIUM - MongoDB → DynamoDB SDK |
| **ElastiCache Redis** | Waitroom | LOW - Connection string only |

### Key Decisions

1. **Inventory → Aurora (NOT DynamoDB)**
   - Requires pessimistic locking (`SELECT FOR UPDATE`)
   - Multi-row ACID transactions (25+ items per order)
   - `SKIP LOCKED` for background jobs
   - Zero code changes

2. **Waitroom → ElastiCache (NOT SQS FIFO)**
   - Exact position tracking (Redis `ZRANK`)
   - Real-time streaming (Redis Pub/Sub + gRPC)
   - Sub-10ms latency
   - Zero code changes

3. **Order → DynamoDB**
   - Document storage fits NoSQL model
   - Global Tables for multi-region
   - No complex transaction requirements

---

## Infrastructure Components

### Compute
- **EKS** - Kubernetes cluster (v1.29+)
- **Karpenter** - Auto-scaling EC2 nodes (spot instances)
- **Lambda** - Auxiliary functions

### Networking
- **VPC** - 3 AZs, public/private subnets
- **ALB** - API Gateway ingress (HTTPS)
- **NLB** - Internal gRPC services
- **API Gateway** - Lambda endpoints

### Event Streaming
- **Kafka** - Self-hosted on EKS (3 brokers)
- **EventBridge** - Lambda triggers from Kafka

### Orchestration
- **Temporal** - Self-hosted on EKS (saga workflows)

### Security
- **WAF** - ALB protection
- **IRSA** - Pod-level AWS credentials
- **Secrets Manager** - Database credentials
- **Network Policies** - Pod-to-pod isolation

### Observability
- **CloudWatch** - Logs, metrics, Container Insights
- **X-Ray** - Distributed tracing
- **Prometheus + Grafana** - Kubernetes metrics

---

## Cost Estimate

### Monthly (Primary + Secondary Region)

| Category | Cost |
|----------|------|
| EKS + EC2 (spot) | $117 |
| Aurora Serverless v2 | $270 |
| DynamoDB | $110 |
| ElastiCache Redis | $100 |
| Lambda | $10 |
| Networking (ALB, NLB) | $50 |
| Monitoring | $45 |
| Other (WAF, Secrets, ECR) | $31 |
| **Total** | **~$733/month** |

With Savings Plans: **~$590/month**

---

## Implementation Phases

### Phase 1: Foundation (Week 1)
- VPC, EKS cluster, ECR repositories
- Aurora Serverless v2, DynamoDB tables, ElastiCache
- Terraform IaC for all infrastructure

### Phase 2: Core Migration (Week 2)
- Deploy 7 microservices to EKS
- Database migrations (PostgreSQL → Aurora, MongoDB → DynamoDB)
- Kafka cluster on EKS

### Phase 3: Auxiliary + Security (Week 3)
- Lambda functions (webhooks, notifications, PDF)
- EventBridge rules for Kafka → Lambda
- Security implementation (WAF, Network Policies, IRSA)

### Phase 4: Multi-Region + Production (Week 4)
- Secondary region deployment
- Route 53 failover routing
- Load testing, chaos engineering
- Documentation, runbooks

---

## Success Criteria

| Metric | Target |
|--------|--------|
| Availability | 99.9% |
| API Latency (p99) | <500ms |
| Inventory Latency (p99) | <100ms |
| Concurrent Users | 10,000 |
| Failover RTO | <5 min |
| Failover RPO | <1 min |
| Cost | <$800/month |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Aurora connection exhaustion | RDS Proxy, connection pooling |
| Kafka broker failures | Strimzi Operator, replication factor 3 |
| Lambda cold starts | Provisioned concurrency for webhooks |
| DynamoDB throttling | On-demand capacity, DAX caching |

---

## References

- [Amazon EKS Best Practices](https://aws.github.io/aws-eks-best-practices/)
- [Aurora Serverless v2 Guide](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html)
- [Strimzi - Kafka on Kubernetes](https://strimzi.io/)
- [Temporal Self-Hosted](https://docs.temporal.io/cluster-deployment-guide)

---

*See [ARC.md](./ARC.md) for detailed architecture documentation.*
