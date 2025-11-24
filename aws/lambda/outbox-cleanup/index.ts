/**
 * Outbox Cleanup Lambda
 *
 * Deletes old published events from the outbox table
 * Triggered by EventBridge Scheduler (daily at 2 AM UTC)
 *
 * Environment Variables:
 * - DATABASE_URL: Aurora PostgreSQL connection string
 * - RETENTION_DAYS: Number of days to retain published events (default: 7)
 * - CLOUDWATCH_NAMESPACE: CloudWatch namespace for metrics
 */

import { ScheduledEvent } from 'aws-lambda';
import { PrismaClient } from '@prisma/client';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';

const prisma = new PrismaClient();
const cloudwatch = new CloudWatchClient({});

// Configuration
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '7', 10);
const MAX_RETRIES = 5;

export const handler = async (event: ScheduledEvent): Promise<void> => {
  console.log('Outbox cleanup triggered:', JSON.stringify(event));

  try {
    // Delete old published events
    const deletedCount = await deleteOldPublishedEvents();
    console.log(`Cleanup complete: ${deletedCount} events deleted`);

    // Monitor failed events
    const failedEvents = await monitorFailedEvents();

    // Publish metrics to CloudWatch
    await publishMetrics(deletedCount, failedEvents.length);
  } catch (error) {
    console.error('Error in outbox cleanup:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
};

async function deleteOldPublishedEvents(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);

  const result = await prisma.outbox.deleteMany({
    where: {
      published: true,
      publishedAt: { lt: cutoffDate },
    },
  });

  console.log(
    `Deleted ${result.count} old published events older than ${RETENTION_DAYS} days`
  );

  return result.count;
}

async function monitorFailedEvents(): Promise<any[]> {
  const failedEvents = await prisma.outbox.findMany({
    where: {
      published: false,
      retryCount: { gte: MAX_RETRIES },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (failedEvents.length > 0) {
    console.warn(`Found ${failedEvents.length} events that exceeded max retries`, {
      eventIds: failedEvents.map((e) => e.id),
    });

    // Log details for debugging
    for (const event of failedEvents.slice(0, 10)) {
      console.warn(`Failed event: ${event.id}`, {
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        retryCount: event.retryCount,
        lastError: event.lastError,
        createdAt: event.createdAt,
      });
    }
  }

  return failedEvents;
}

async function publishMetrics(
  deletedCount: number,
  failedCount: number
): Promise<void> {
  const namespace = process.env.CLOUDWATCH_NAMESPACE || 'TicketBottle/Outbox';

  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: namespace,
        MetricData: [
          {
            MetricName: 'EventsDeleted',
            Value: deletedCount,
            Unit: 'Count',
            Dimensions: [{ Name: 'Service', Value: 'outbox-cleanup' }],
          },
          {
            MetricName: 'FailedEvents',
            Value: failedCount,
            Unit: 'Count',
            Dimensions: [{ Name: 'Service', Value: 'outbox-cleanup' }],
          },
        ],
      })
    );

    console.log('Metrics published to CloudWatch');
  } catch (error) {
    console.error('Failed to publish metrics:', error);
    // Don't throw - metrics failure shouldn't fail the cleanup
  }
}
