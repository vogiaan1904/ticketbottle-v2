# TicketBottle V2 - Distributed Ticket Selling Platform

<p align="center">
  <strong>A high-performance, scalable microservices-based ticket selling system designed to handle high-traffic ticket sales with virtual queuing, real-time inventory management, and reliable payment processing.</strong>
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Go](https://img.shields.io/badge/Go-00ADD8?logo=go&logoColor=white)](https://golang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
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
- [Database Architecture](#database-architecture)
- [Getting Started](#getting-started)
- [Design Patterns](#design-patterns)
- [Deployment](#deployment)

---

## Overview

TicketBottle V2 is a production-ready, distributed ticket selling platform built with microservices architecture. The system is designed to handle high-demand ticket sales scenarios (concerts, sports events, conferences) with features like:

- **Virtual Waiting Room** - Fair queue management for high-traffic ticket sales
- **Real-time Inventory Management** - Atomic ticket reservation and confirmation
- **Multi-provider Payment Processing** - Support for multiple payment gateways (ZaloPay, PayOS, VNPay)
- **Event-Driven Architecture** - Reliable event processing with Kafka
- **High Availability** - Distributed services with horizontal scaling capability

The system uses a polyglot microservices approach, leveraging the strengths of different technologies:

- **Go** for high-performance, concurrent services (Inventory, Order, Waitroom)
- **TypeScript/NestJS** for feature-rich business logic services (API Gateway, User, Event, Payment)

---

## System Architecture

![system architecture](/images/architecture.png)

---

## Services

### 1. **API Gateway** (TypeScript/NestJS)

**Port:** 3000 | **Protocol:** HTTP/REST

The unified entry point for all client requests.

**Responsibilities:**

- REST API exposure to web and mobile clients
- JWT authentication and authorization
- Request validation and transformation
- Rate limiting and request throttling
- gRPC client management and request forwarding
- Swagger API documentation
- CORS management

**Key Dependencies:**

- `@nestjs/microservices` - gRPC client
- `@nestjs/jwt` - JWT authentication
- `@nestjs/swagger` - API documentation
- `express-rate-limit` - Rate limiting
- `helmet` - Security headers

---

### 2. **User Service** (TypeScript/NestJS)

**Port:** 50051 | **Protocol:** gRPC | **Database:** PostgreSQL

Handles user management and authentication.

**Responsibilities:**

- User registration and profile management
- User authentication (via API Gateway)
- User data persistence
- Email verification management

**Database Schema:**

- User table with fields: id, firstName, lastName, email, password (hashed), avatar, emailVerified, createdAt, updatedAt

**gRPC Methods:**

- `Create` - Register new user
- `Update` - Update user profile
- `FindOne` - Get user by ID or email
- `FindAll` - Batch user lookup
- `Delete` - Soft delete user

---

### 3. **Event Service** (TypeScript/NestJS)

**Port:** 50053 | **Protocol:** gRPC | **Database:** PostgreSQL

Manages events, organizers, and event configurations.

**Responsibilities:**

- Event creation and management
- Event configuration (ticket sales, waitroom settings)
- Event categorization and search
- Event role management (admin, editor, viewer)
- Event status workflow (draft → configured → approved → published)
- Organizer management

**Event Status Flow:**

- DRAFT → CONFIGURED → APPROVED → PUBLISHED
- Any status can transition to CANCELLED

---

### 4. **Inventory Service** (Go/GORM)

**Port:** 50054 | **Protocol:** gRPC | **Database:** PostgreSQL

High-performance ticket inventory management with atomic operations.

**Responsibilities:**

- Ticket class creation and management
- Real-time availability checking
- Atomic ticket reservation (reserve/confirm/release)
- Ticket inventory tracking (total, reserved, sold)
- Expiration handling for stale reservations

**Availability Formula:**

- available = total - reserved - sold

**Key Operations:**

- `Reserve` - Atomically reserve tickets for an order (15-minute hold)
- `Confirm` - Convert reservation to sale (payment completed)
- `Release` - Free reserved tickets (payment failed/expired)

**Background Job:**

- Periodic cleanup of expired reservations (every 1 minute)

---

### 5. **Order Service** (Go/MongoDB)

**Port:** 50055 | **Protocol:** gRPC | **Database:** MongoDB

**Saga Orchestrator** - Coordinates distributed transactions across multiple services.

**Responsibilities:**

- Order creation with multi-step coordination
- Saga orchestration for distributed transactions
- Compensation/rollback on transaction failures
- Order status management
- Payment coordination
- Inventory reservation coordination
- Order history and queries

**Saga Pattern Implementation:**

The Order Service implements the **Saga Orchestration Pattern** to manage distributed transactions across Event, Inventory, and Payment services. Each order creation is a saga with multiple steps:

**Saga Steps (Forward Flow):**

1. **Validate Event** - Verify event exists and is published (Event Service gRPC)
2. **Validate Event Config** - Check event configuration (Event Service gRPC)
3. **Validate Checkout Token** - If waitroom enabled, verify JWT token
4. **Get Ticket Classes** - Fetch ticket information (Inventory Service gRPC)
5. **Check Availability** - Verify sufficient ticket inventory (Inventory Service gRPC)
6. **Reserve Tickets** - Atomically reserve tickets with 15-min hold (Inventory Service gRPC) ✓ _Saga tracking begins_
7. **Create Order** - Persist order record (MongoDB) ✓ _Saga tracked_
8. **Create Order Items** - Persist order line items (MongoDB) ✓ _Saga tracked_
9. **Create Payment Intent** - Generate payment URL (Payment Service gRPC)
10. **Return Payment URL** - Complete order creation

**Compensation/Rollback (Reverse Flow):**
If any step fails after saga tracking begins, the service automatically compensates:

- **Release Tickets** - Cancel inventory reservation (Inventory Service gRPC)
- **Delete Order Items** - Remove order line items (MongoDB)
- **Delete Order** - Remove order record (MongoDB)

**Asynchronous Saga Continuation (via Kafka):**

- **Payment Completed Event** → Confirm inventory reservation → Update order status to COMPLETED → Publish CHECKOUT_COMPLETED
- **Payment Failed Event** → Release inventory reservation → Update order status to FAILED → Publish CHECKOUT_FAILED
- **Payment Expired Event** → Release inventory reservation → Update order status to CANCELLED

**Saga State Tracking:**
The service maintains a `SagaCompensation` structure to track completed steps:

- `CreatedOrder` - Order record created
- `ItemsCreated` - Order items created
- `TicketsReserved` - Inventory reservation made

This ensures accurate rollback in case of failures at any point in the transaction.

---

### 6. **Payment Service** (TypeScript/NestJS)

**Port:** 50052 | **Protocol:** gRPC | **Database:** PostgreSQL

Multi-provider payment processing with outbox pattern for reliability.

**Responsibilities:**

- Payment intent creation
- Payment confirmation and cancellation
- Multi-provider support (ZaloPay, PayOS, VNPay)
- Payment status tracking
- Webhook handling
- Event publishing via Outbox pattern

**Outbox Pattern:**
Ensures exactly-once event delivery by atomically saving payment updates and events in the same database transaction. Payment updates and outbox entries are saved in a single atomic transaction, then a background worker publishes events from the outbox to Kafka.

**Payment Flow:**

1. Create payment intent → Get payment URL
2. User completes payment on provider site
3. Provider sends webhook → Update payment status
4. Save event to outbox (atomic with payment update)
5. Background worker publishes event to Kafka
6. Order service consumes event → Confirms order

---

### 7. **Waitroom Service** (Go/Redis/Kafka)

**Port:** 50056 | **Protocol:** gRPC | **Database:** Redis

Virtual queue management for high-traffic ticket sales.

**Responsibilities:**

- Queue session management
- Fair queue processing (FIFO)
- Checkout token generation (JWT)
- Real-time position updates
- Automatic queue admission when slots available
- Session expiration handling

**Redis Data Structures:**

**Sessions (Hash):**

- Key: `waitroom:session:{session_id}`
- Value: JSON with id, user_id, event_id, status (queued → admitted → completed), position, checkout_token (JWT), queued_at, expires_at, admitted_at, checkout_expires_at

**Queue (Sorted Set):**

- Key: `waitroom:{event_id}:queue`
- Score: Unix timestamp (FIFO ordering)
- Members: session_ids

**Processing Set (Set):**

- Key: `waitroom:{event_id}:processing`
- Members: session_ids of users currently in checkout
- Max 100 concurrent (configurable)

**Queue Processor:**
Background job running every 1 second:

1. Check processing count (how many users in checkout)
2. Calculate available slots (max 100 - current processing)
3. Pop users from front of queue
4. Generate JWT checkout token for each user
5. Update session status to "admitted"
6. Add to processing set (15-minute TTL)
7. Publish QUEUE_READY event to Kafka

**Session States:**

- QUEUED → ADMITTED → COMPLETED
- QUEUED → EXPIRED

**Kafka Events:**

- `queue.joined` - User joins queue
- `queue.left` - User leaves queue
- `queue.ready` - User admitted to checkout (consumed by Order service)

**Kafka Event Consumers:**

- `checkout.completed` - Remove from processing, free slot
- `checkout.failed` - Remove from processing, free slot
- `checkout.expired` - Remove from processing, free slot

---

## Technology Stack

### Languages & Frameworks

| Service           | Language   | Framework | Key Libraries                          |
| ----------------- | ---------- | --------- | -------------------------------------- |
| API Gateway       | TypeScript | NestJS    | `@nestjs/microservices`, `@nestjs/jwt` |
| User Service      | TypeScript | NestJS    | Prisma, bcryptjs                       |
| Event Service     | TypeScript | NestJS    | Prisma, `@nestjs/cqrs`                 |
| Payment Service   | TypeScript | NestJS    | Prisma, KafkaJS, `@nestjs/schedule`    |
| Inventory Service | Go 1.25    | -         | GORM, gRPC                             |
| Order Service     | Go 1.25    | -         | MongoDB Driver, Sarama (Kafka)         |
| Waitroom Service  | Go 1.25    | -         | Redis, Sarama (Kafka), JWT             |

### Databases & Storage

- **PostgreSQL** - User, Event, Inventory, Payment data
- **MongoDB** - Order data (document-based for flexibility)
- **Redis** - Waitroom sessions, queue management, caching

### Communication

- **gRPC** - Inter-service synchronous communication
- **Kafka** - Event streaming and asynchronous messaging
- **Protocol Buffers** - Service contract definitions

### Development & Tools

- **Docker** - Containerization
- **Prisma** - TypeScript ORM and migrations
- **GORM** - Go ORM
- **Winston** - Logging (TypeScript services)
- **Zap** - Logging (Go services)
- **Swagger** - API documentation

---

## ✨ Key Features

### 1. **Virtual Waiting Room**

- Fair FIFO queue management for high-traffic sales
- Automatic admission when checkout slots available
- Real-time position updates
- JWT-based checkout tokens with expiration
- Configurable max concurrent users (default: 100)
- Session TTL and automatic cleanup

### 2. **Atomic Inventory Management**

- Pessimistic locking for ticket reservations
- Three-step reservation flow: Reserve → Confirm/Release
- Automatic cleanup of expired reservations
- Real-time availability checking
- Support for multiple ticket classes per event

### 3. **Multi-Provider Payment Processing**

- Support for ZaloPay, PayOS, VNPay
- Webhook handling for payment confirmation
- Outbox pattern for reliable event delivery
- Automatic retry on event publishing failures
- Idempotent payment operations

### 4. **Distributed Transaction Management (Saga Pattern)**

- Saga orchestration for multi-service transactions
- Automatic compensation/rollback on failures
- State tracking for transaction progress
- Idempotent operations for safe retries
- Mixed synchronous (gRPC) and asynchronous (Kafka) coordination

### 5. **Event-Driven Architecture**

- Asynchronous event processing with Kafka
- Reliable event delivery with Outbox pattern
- Event replay capability
- Loose coupling between services
- Horizontal scalability

### 6. **High Availability**

- Stateless service design
- Database connection pooling
- Graceful shutdown handling
- Health check endpoints
- Circuit breaker patterns (future)

### 7. **Security**

- JWT-based authentication
- Role-based access control (Event roles)
- Rate limiting on API Gateway
- CORS configuration
- Helmet security headers
- Password hashing with bcrypt

---

## Data Flow

### Complete Ticket Purchase Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. USER JOINS WAITROOM                                          │
├─────────────────────────────────────────────────────────────────┤
│ User → API Gateway → Waitroom Service                           │
│   ├─ Create session in Redis                                    │
│   ├─ Add to queue (sorted set)                                  │
│   ├─ Publish QUEUE_JOINED event                                 │
│   └─ Return position in queue                                   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. QUEUE PROCESSOR (Background Job - Every 1s)                  │
├─────────────────────────────────────────────────────────────────┤
│ Waitroom Service                                                │
│   ├─ Check available checkout slots (100 - processing count)    │
│   ├─ Pop users from queue (batch of 10)                         │
│   ├─ Generate JWT checkout token (15-min expiry)                │
│   ├─ Update session status → "admitted"                         │
│   ├─ Add to processing set                                      │
│   └─ Publish QUEUE_READY event → Kafka                          │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. USER POLLS STATUS & GETS CHECKOUT ACCESS                     │
├─────────────────────────────────────────────────────────────────┤
│ User → API Gateway → Waitroom Service                           │
│   └─ Return: status="admitted", checkout_token, checkout_url    │
│                                                                 │
│ User → Navigate to checkout page with token                     │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. CREATE ORDER                                                 │
├─────────────────────────────────────────────────────────────────┤
│ User → API Gateway → Order Service                              │
│   ├─ Validate event (Event Service gRPC)                        │
│   ├─ Get ticket prices (Inventory Service gRPC)                 │
│   ├─ Check availability (Inventory Service gRPC)                │
│   │   └─ Response: available=true/false                         │
│   ├─ Reserve tickets (Inventory Service gRPC)                   │
│   │   └─ Atomic: increment reserved count                       │
│   ├─ Create order record (MongoDB)                              │
│   │   └─ Status: PENDING                                        │
│   └─ Create payment intent (Payment Service gRPC)               │
│       └─ Return payment URL                                     │
│                                                                 │
│ Response → User receives payment redirect URL                   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. PAYMENT PROCESSING                                           │
├─────────────────────────────────────────────────────────────────┤
│ User → Payment Provider (ZaloPay/PayOS/VNPay)                   │
│   └─ Complete payment on provider site                          │
│                                                                 │
│ Payment Provider → Webhook → Payment Service                    │
│   ├─ Atomic Transaction:                                        │
│   │   ├─ Update payment status → COMPLETED                      │
│   │   └─ Save event to Outbox table                             │
│   └─ Return 200 OK to provider                                  │
│                                                                 │
│ Background Worker (Every 5s):                                   │
│   ├─ Fetch unpublished events from Outbox                       │
│   ├─ Publish PAYMENT_COMPLETED event → Kafka                    │
│   └─ Mark event as published                                    │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. ORDER COMPLETION (Kafka Consumer)                            │
├─────────────────────────────────────────────────────────────────┤
│ Order Service consumes PAYMENT_COMPLETED event                  │
│   ├─ Confirm inventory reservation (Inventory Service gRPC)     │
│   │   └─ Atomic: decrement reserved, increment sold             │
│   ├─ Update order status → COMPLETED                            │
│   └─ Publish ORDER_COMPLETED event → Kafka                      │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. WAITROOM CLEANUP (Kafka Consumer)                            │
├─────────────────────────────────────────────────────────────────┤
│ Waitroom Service consumes CHECKOUT_COMPLETED event              │
│   ├─ Remove session from processing set                         │
│   ├─ Update session status → completed                          │
│   └─ Free checkout slot for next user in queue                  │
└─────────────────────────────────────────────────────────────────┘
```

### Error Scenarios

**Payment Failure:**

- Payment Failed → PAYMENT_FAILED event
- Order Service: Release inventory reservation
- Order Service: Update order status → FAILED
- Waitroom Service: Free checkout slot

**Payment Timeout (15 minutes):**

- Payment Expired → PAYMENT_EXPIRED event
- Order Service: Release inventory reservation
- Order Service: Update order status → CANCELLED
- Waitroom Service: Free checkout slot

**Insufficient Inventory:**

- Order Creation → Check availability → Insufficient stock
- Return error to user (before reservation)

---

## Communication Patterns

### 1. **Synchronous (gRPC)**

Used for request-response operations requiring immediate feedback:

- API Gateway → User Service (Get user details)
- API Gateway → Event Service (Get event info)
- Order Service → Inventory (Reserve tickets)
- Order Service → Payment (Create payment intent)
- Waitroom → Event Service (Get active events)

**Benefits:**

- Type safety with Protocol Buffers
- Bi-directional streaming support
- Better performance than REST
- Built-in load balancing

### 2. **Asynchronous (Kafka)**

Used for event notifications and eventual consistency:

- Payment Service → Kafka → Order Service (Event: PAYMENT_COMPLETED)
- Order Service → Kafka → Waitroom Service (Event: CHECKOUT_COMPLETED)
- Waitroom Service → Kafka → Analytics Service (Events: QUEUE_JOINED, QUEUE_READY)

**Kafka Topics:**

- `payment-events` - Payment lifecycle events
- `order-events` - Order lifecycle events
- `queue-events` - Waitroom events
- `inventory-events` - Stock level changes

**Benefits:**

- Loose coupling between services
- Event replay capability
- Horizontal scaling of consumers
- Fault tolerance

---

## Database Architecture

### PostgreSQL Databases

**User Service:**

**Event Service:**

**Inventory Service:**

**Payment Service:**

### MongoDB Database

**Order Service:**

### Redis Data Structures

**Waitroom Service:**

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

### 1. **Saga Pattern** (Order Service)

Manages distributed transactions across multiple microservices with compensation logic.

**Problem:** Maintaining data consistency across multiple services without traditional ACID transactions.

**Solution:** The Order Service implements Saga Orchestration pattern - it acts as the orchestrator coordinating a sequence of local transactions across Event, Inventory, and Payment services.

**Implementation:**

- **Forward Flow:** Execute steps sequentially (validate event → check availability → reserve tickets → create order → create payment)
- **Compensation Flow:** If any step fails, execute compensating transactions in reverse order (release tickets → delete order items → delete order)
- **State Tracking:** Maintain saga state to know which steps completed successfully
- **Idempotency:** Each step is designed to be idempotent to handle retries safely
- **Asynchronous Continuation:** Saga continues via Kafka events for payment completion/failure

**Benefits:**

- Maintains data consistency without distributed locks
- Provides automatic rollback on failures
- Supports long-running transactions
- Resilient to partial failures

### 2. **Outbox Pattern** (Payment Service)

Ensures atomic database updates and event publishing.

**Problem:** Dual-write problem - updating database and publishing event can fail independently.

**Solution:** Save events to an outbox table in the same transaction as the business logic. Background worker publishes events from outbox.

**Implementation:** Atomic transaction updates payment status and creates outbox entry together. Background worker (every 5 seconds) fetches unpublished events, publishes to Kafka, and marks as published.

### 3. **Repository Pattern** (All Services)

Abstracts data access logic from business logic.

### 4. **Service Layer Pattern** (All Services)

Encapsulates business logic separate from delivery mechanisms (gRPC, HTTP, Kafka).

### 5. **CQRS (Command Query Responsibility Segregation)** (Event Service)

Separates read and write operations for scalability.

### 6. **Event Sourcing** (Partial - via Kafka)

Events are the source of truth, stored in Kafka topics for replay.

### 7. **Circuit Breaker** (Future Enhancement)

Prevents cascading failures in distributed system.

---

## Deployment

_To be updated_

---

## Monitoring & Observability

### Logging

**TypeScript Services:** Winston with daily rotate file for structured logging

**Go Services:** Uber Zap for high-performance structured logging

### Metrics (Future)

- Service health checks
- Request latency
- Queue lengths
- Event processing lag
- Database connection pool usage

### Tracing (Future)

- Distributed tracing with OpenTelemetry
- Request correlation IDs

---

## Security

1. **Authentication:** JWT tokens with expiration
2. **Authorization:** Role-based access control (Event roles)
3. **Rate Limiting:** Express rate limiter on API Gateway
4. **Input Validation:** Class-validator on all inputs
5. **SQL Injection Prevention:** Parameterized queries (Prisma, GORM)
6. **Password Hashing:** bcrypt with salt
7. **CORS:** Configured origins
8. **Headers:** Helmet security headers

---

## Testing

_To be updated_

---

## API Documentation

Interactive API documentation available at:

- **Development:** to be updated
- **Staging:** to be updated

Powered by Swagger/OpenAPI 3.0

---

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

---

## 📄 License

This project is licensed under the MIT License.

---

## Authors

**Vo Gia An**

---

## Acknowledgments

- NestJS framework
- Go community
- Kafka ecosystem
- Prisma ORM
- All open-source contributors

---

## Support

For questions and support:

- Email: vogiaan1904@gmail.com
- Issues: GitHub Issues
- Docs: [Documentation](to be updated)

---

**Built with passion**
