# TicketBottle V2 - Distributed Ticket Selling Platform

<p align="center">
  <strong>A high-performance, scalable microservices-based ticket selling system designed to handle high-traffic ticket sales with virtual queuing, real-time inventory management, and reliable payment processing.</strong>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Go](https://img.shields.io/badge/Go-00ADD8?logo=go&logoColor=white)](https://golang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![Temporal](https://img.shields.io/badge/Temporal-000000?logo=temporal&logoColor=white)](https://temporal.io/)
[![gRPC](https://img.shields.io/badge/gRPC-4285F4?logo=google&logoColor=white)](https://grpc.io/)
[![MongoDB](https://img.shields.io/badge/MongoDB-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![Kafka](https://img.shields.io/badge/Kafka-231F20?logo=apachekafka&logoColor=white)](https://kafka.apache.org/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

---

## 📋 Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Services](#services)
- [Technology Stack](#technology-stack)
- [Key Features](#key-features)
- [Data Flow](#data-flow)
- [Communication Patterns](#communication-patterns)
- [Getting Started](#getting-started)
- [Design Patterns](#design-patterns)
- [Observability & Security](#observability--security)

---

## Overview

TicketBottle V2 is a production-ready, distributed ticket selling platform built with microservices architecture. The system is designed to handle high-demand ticket sales scenarios (concerts, sports events, conferences) with:

- **Virtual Waiting Room** - Fair queue management for high-traffic ticket sales
- **Real-time Inventory Management** - Atomic ticket reservation with pessimistic locking
- **Multi-provider Payment Processing** - ZaloPay, PayOS, VNPay integration
- **Temporal Workflows** - Reliable saga orchestration for distributed transactions
- **Event-Driven Architecture** - Asynchronous event processing with Kafka
- **Polyglot Microservices** - Go for performance-critical services, TypeScript/NestJS for business logic

---

## System Architecture

![system architecture](/images/architecture.png)

---

## Services

### 1. **API Gateway** (TypeScript/NestJS)
**Port:** 3000 | **Protocol:** HTTP/REST

Unified entry point providing REST APIs, JWT authentication, rate limiting, request validation, and gRPC client management. Includes Swagger documentation for all endpoints.

---

### 2. **User Service** (TypeScript/NestJS)
**Port:** 50051 | **Protocol:** gRPC | **Database:** PostgreSQL

Handles user registration, authentication, profile management, and email verification.

---

### 3. **Event Service** (TypeScript/NestJS)
**Port:** 50053 | **Protocol:** gRPC | **Database:** PostgreSQL

Manages events, organizers, and configurations. Implements event lifecycle (DRAFT → CONFIGURED → APPROVED → PUBLISHED) and role-based access control.

---

### 4. **Inventory Service** (Go/GORM)
**Port:** 50054 | **Protocol:** gRPC | **Database:** PostgreSQL

High-performance ticket inventory management using pessimistic locking for atomic operations. Implements three-step reservation flow: `Reserve → Confirm/Release` with automatic cleanup of expired reservations.

**Key Operations:**
- `Reserve` - Lock tickets with 15-minute hold
- `Confirm` - Convert reservation to sale
- `Release` - Free reserved tickets

---

### 5. **Order Service** (Go/MongoDB/Temporal)
**Port:** 50055 | **Protocol:** gRPC | **Database:** MongoDB

**Saga Orchestrator** using **Temporal workflows** to coordinate distributed transactions across Event, Inventory, and Payment services.

**Temporal Workflows:**
- `CreateOrder` - Multi-step saga with automatic compensation
- `ConfirmOrder` - Asynchronous order confirmation from payment events

**Saga Flow:**
1. Check availability → Reserve tickets → Create order → Create payment intent
2. On payment success: Confirm inventory → Update order status → Publish events
3. On failure: Automatic compensation (release tickets, delete order)

**Compensation Tracking:** Temporal workflow state ensures accurate rollback at any failure point.

---

### 6. **Payment Service** (TypeScript/NestJS)
**Port:** 50052 | **Protocol:** gRPC | **Database:** PostgreSQL

Multi-provider payment processing (ZaloPay, PayOS, VNPay) with **Outbox Pattern** for reliable event delivery. Atomically saves payment updates and events in the same transaction, with background workers publishing to Kafka.

---

### 7. **Waitroom Service** (Go/Redis/Kafka)
**Port:** 50056 | **Protocol:** gRPC | **Database:** Redis

Virtual queue management using Redis sorted sets for FIFO ordering. Background processor admits users when checkout slots are available (max 100 concurrent, configurable).

**Key Features:**
- JWT-based checkout tokens with 15-minute expiration
- Real-time position updates
- Automatic session cleanup
- Kafka event publishing for queue lifecycle

---

## Technology Stack

### Languages & Frameworks

| Service           | Language   | Framework | Key Libraries                               |
| ----------------- | ---------- | --------- | ------------------------------------------- |
| API Gateway       | TypeScript | NestJS    | `@nestjs/microservices`, `@nestjs/jwt`      |
| User Service      | TypeScript | NestJS    | Prisma, bcryptjs                            |
| Event Service     | TypeScript | NestJS    | Prisma, `@nestjs/cqrs`                      |
| Payment Service   | TypeScript | NestJS    | Prisma, KafkaJS, `@nestjs/schedule`         |
| Inventory Service | Go 1.25    | -         | GORM, gRPC                                  |
| Order Service     | Go 1.25    | -         | Temporal, MongoDB Driver, Sarama (Kafka)    |
| Waitroom Service  | Go 1.25    | -         | Redis, Sarama (Kafka), JWT                  |

### Infrastructure & Communication

- **Temporal** - Workflow orchestration and saga management
- **gRPC** - Inter-service synchronous communication
- **Kafka** - Event streaming and asynchronous messaging
- **PostgreSQL** - User, Event, Inventory, Payment data
- **MongoDB** - Order data (document-based for flexibility)
- **Redis** - Waitroom sessions, queue management, caching
- **Docker** - Containerization

---

## ✨ Key Features

### **Virtual Waiting Room**
Fair FIFO queue management using Redis sorted sets, automatic admission when slots available, JWT-based checkout tokens.

### **Atomic Inventory Management**
Pessimistic locking with three-step flow (Reserve → Confirm/Release), automatic cleanup of expired reservations.

### **Temporal Workflow Orchestration**
Saga pattern implementation using Temporal for distributed transactions, automatic compensation on failures, durable execution state.

### **Outbox Pattern for Events**
Exactly-once event delivery by atomically saving business data and events in the same transaction.

### **Multi-Provider Payments**
ZaloPay, PayOS, VNPay integration with webhook handling and idempotent operations.

### **Event-Driven Architecture**
Asynchronous event processing with Kafka for loose coupling and horizontal scalability.

---

## Data Flow

### Complete Ticket Purchase Flow

**1. Join Waitroom**
User → Waitroom Service → Create Redis session → Add to queue (sorted set) → Return position

**2. Queue Processing (Background - 1s interval)**
Waitroom Service → Check available slots → Pop users from queue → Generate JWT tokens → Update to "admitted" → Publish `QUEUE_READY` event

**3. Checkout Admitted**
User polls status → Receives checkout token → Navigates to checkout page

**4. Create Order (Temporal Workflow)**
API Gateway → Order Service → Temporal `CreateOrder` workflow:
- Check availability (Inventory Service)
- Reserve tickets atomically (Inventory Service)
- Create order record (MongoDB)
- Create payment intent (Payment Service)
- Return payment URL to user

**5. Payment Processing**
User → Payment Provider → Complete payment → Webhook → Payment Service:
- Atomic transaction: Update payment + Save to Outbox
- Background worker: Publish `PAYMENT_COMPLETED` to Kafka

**6. Order Confirmation (Kafka Consumer)**
Order Service consumes `PAYMENT_COMPLETED` → Temporal `ConfirmOrder` workflow:
- Confirm inventory (decrement reserved, increment sold)
- Update order status → COMPLETED
- Publish `CHECKOUT_COMPLETED` event

**7. Waitroom Cleanup**
Waitroom Service consumes `CHECKOUT_COMPLETED` → Free checkout slot → Admit next user

### Error Handling

**Payment Failure/Timeout:** Temporal workflow compensation → Release inventory → Update order status → Free checkout slot

**Insufficient Inventory:** Fail fast before reservation → Return error to user

---

## Communication Patterns

### **Synchronous (gRPC)**
Used for request-response operations requiring immediate feedback. Protocol Buffers provide type safety and better performance than REST.

**Examples:** Order → Inventory (reserve tickets), Order → Payment (create intent), API Gateway → User/Event services

### **Asynchronous (Kafka)**
Used for event notifications and eventual consistency. Enables loose coupling and horizontal scalability.

**Topics:** `payment-events`, `order-events`, `queue-events`, `inventory-events`

**Examples:** Payment → Order (payment completed), Order → Waitroom (checkout completed)

### **Temporal Workflows**
Used for long-running, stateful processes requiring automatic compensation and retry logic.

**Examples:** `CreateOrder` workflow, `ConfirmOrder` workflow

---

## Getting Started

### Prerequisites

- **Docker** >= 20.10
- **Docker Compose** >= 2.0
- **Node.js** >= 18.x (for TypeScript services)
- **Go** >= 1.25 (for Go services)
- **PostgreSQL** >= 14
- **MongoDB** >= 5.0
- **Redis** >= 7.0
- **Kafka** >= 3.0
- **Temporal** >= 1.24

### Environment Setup

_To be updated_

### Service Endpoints

| Service           | Port  | Type | Endpoint                       |
| ----------------- | ----- | ---- | ------------------------------ |
| API Gateway       | 3000  | HTTP | http://localhost:3000/api      |
| API Docs          | 3000  | HTTP | http://localhost:3000/api/docs |
| User Service      | 50051 | gRPC | localhost:50051                |
| Payment Service   | 50052 | gRPC | localhost:50052                |
| Event Service     | 50053 | gRPC | localhost:50053                |
| Inventory Service | 50054 | gRPC | localhost:50054                |
| Order Service     | 50055 | gRPC | localhost:50055                |
| Waitroom Service  | 50056 | gRPC | localhost:50056                |

---

## Design Patterns

### **Saga Pattern with Temporal** (Order Service)
Manages distributed transactions across multiple services with automatic compensation. Temporal provides durable execution state, automatic retries, and compensation orchestration.

**Implementation:** `CreateOrder` and `ConfirmOrder` workflows coordinate Event, Inventory, and Payment services. On failure, Temporal automatically executes compensating activities (release tickets → delete order items → delete order).

### **Outbox Pattern** (Payment Service)
Ensures exactly-once event delivery by atomically saving business data and events in the same database transaction. Background workers publish events from the outbox to Kafka.

### **Repository Pattern** (All Services)
Abstracts data access logic from business logic for testability and flexibility.

### **CQRS** (Event Service)
Separates read and write operations for independent scaling and optimization.

---

## Deployment

_To be updated_

---

## Observability & Security

### Logging
- **TypeScript Services:** Winston with structured logging
- **Go Services:** Uber Zap for high-performance logging
- **Temporal:** Built-in workflow execution history and observability

### Security
- JWT authentication with role-based access control
- Rate limiting on API Gateway
- Input validation, parameterized queries, password hashing (bcrypt)
- CORS and security headers (Helmet)

---

## License & Contact

**License:** MIT

**Author:** Vo Gia An (vogiaan1904@gmail.com)

**Built with:** NestJS, Go, Temporal, Kafka, gRPC, Prisma, and the open-source community
