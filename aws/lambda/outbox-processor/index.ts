/**
 * Outbox Processor Lambda
 *
 * Polls Aurora PostgreSQL outbox table and publishes events to Kafka/MSK
 * Triggered by EventBridge Scheduler (every 1 minute)
 *
 * Environment Variables:
 * - DATABASE_URL: Aurora PostgreSQL connection string
 * - KAFKA_BROKERS: Comma-separated list of Kafka broker addresses
 * - KAFKA_TOPIC_PAYMENT_COMPLETED: Topic for payment completed events
 * - KAFKA_TOPIC_PAYMENT_FAILED: Topic for payment failed events
 */

import { ScheduledEvent } from "aws-lambda";
import { PrismaClient } from "@prisma/client";
import { Kafka, Producer, CompressionTypes } from "kafkajs";
import { randomUUID } from "crypto";

const prisma = new PrismaClient();

// Kafka configuration
const kafka = new Kafka({
  clientId: "outbox-processor-lambda",
  brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
  ssl: process.env.KAFKA_SSL === "true",
  sasl:
    process.env.KAFKA_SASL_USERNAME && process.env.KAFKA_SASL_PASSWORD
      ? {
          mechanism: "scram-sha-256",
          username: process.env.KAFKA_SASL_USERNAME,
          password: process.env.KAFKA_SASL_PASSWORD,
        }
      : undefined,
});

let producer: Producer | null = null;

// Configuration
const BATCH_SIZE = 100;
const MAX_RETRIES = 5;

// Event type to topic mapping
const TOPIC_MAPPING: Record<string, string> = {
  PAYMENT_COMPLETED:
    process.env.KAFKA_TOPIC_PAYMENT_COMPLETED || "payment.completed",
  PAYMENT_FAILED: process.env.KAFKA_TOPIC_PAYMENT_FAILED || "payment.failed",
};

export const handler = async (event: ScheduledEvent): Promise<void> => {
  console.log("Outbox processor triggered:", JSON.stringify(event));

  try {
    // Initialize Kafka producer
    if (!producer) {
      producer = kafka.producer();
      await producer.connect();
    }

    // Get unpublished events
    const events = await prisma.outbox.findMany({
      where: {
        published: false,
        retryCount: { lt: MAX_RETRIES },
      },
      orderBy: { createdAt: "asc" },
      take: BATCH_SIZE,
    });

    if (events.length === 0) {
      console.log("No unpublished events found");
      return;
    }

    console.log(`Processing ${events.length} outbox events`);

    // Process events in parallel with error handling
    const results = await Promise.allSettled(
      events.map((event: any) => publishEvent(event))
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    console.log(
      `Batch processing complete: ${succeeded} succeeded, ${failed} failed`
    );
  } catch (error) {
    console.error("Error in outbox processing:", error);
    throw error;
  }
};

async function publishEvent(event: any): Promise<void> {
  const topic = TOPIC_MAPPING[event.eventType];

  if (!topic) {
    console.warn(`Unknown event type: ${event.eventType}, skipping`);
    await prisma.outbox.update({
      where: { id: event.id },
      data: {
        retryCount: { increment: 1 },
        lastError: `Unknown event type: ${event.eventType}`,
      },
    });
    return;
  }

  try {
    // Publish to Kafka
    await producer!.send({
      topic,
      compression: CompressionTypes.GZIP,
      messages: [
        {
          key: event.aggregateId,
          value: JSON.stringify(event.payload),
          headers: {
            eventType: event.eventType,
            eventVersion: "1.0",
            source: "payment-service",
            correlationId: event.aggregateId,
            messageId: randomUUID(),
          },
        },
      ],
    });

    // Mark as published
    await prisma.outbox.update({
      where: { id: event.id },
      data: {
        published: true,
        publishedAt: new Date(),
      },
    });

    console.log(
      `Event published: ${event.eventType} (${event.aggregateType}:${event.aggregateId})`
    );
  } catch (error: any) {
    console.error(
      `Failed to publish event ${event.id} (attempt ${event.retryCount + 1})`,
      error
    );

    await prisma.outbox.update({
      where: { id: event.id },
      data: {
        retryCount: { increment: 1 },
        lastError: error.message?.substring(0, 500) || "Unknown error",
      },
    });

    throw error;
  }
}

// Graceful shutdown for Lambda extensions
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing connections...");
  if (producer) {
    await producer.disconnect();
  }
  await prisma.$disconnect();
});
