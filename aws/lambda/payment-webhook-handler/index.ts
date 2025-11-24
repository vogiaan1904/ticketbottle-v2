/**
 * Payment Webhook Handler Lambda
 *
 * Handles payment provider callbacks (ZaloPay, PayOS)
 * Triggered via API Gateway HTTP endpoint
 *
 * Environment Variables:
 * - DATABASE_URL: Aurora PostgreSQL connection string
 * - ZALOPAY_KEY2: ZaloPay verification key
 * - PAYOS_CHECKSUM_KEY: PayOS verification key
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PrismaClient, PaymentStatus } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

// Payment provider enum
enum PaymentProvider {
  ZALOPAY = 'zalopay',
  PAYOS = 'payos',
}

// Event types for outbox
enum EventType {
  PAYMENT_COMPLETED = 'PAYMENT_COMPLETED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
}

interface CallbackResult {
  orderCode: string | null;
  success: boolean;
  response: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Payment webhook received:', JSON.stringify(event));

  try {
    const path = event.path || event.requestContext?.http?.path || '';
    const body = event.body ? JSON.parse(event.body) : {};

    let provider: PaymentProvider;
    if (path.includes('zalopay')) {
      provider = PaymentProvider.ZALOPAY;
    } else if (path.includes('payos')) {
      provider = PaymentProvider.PAYOS;
    } else {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Unknown payment provider' }),
      };
    }

    const result = await handleCallback(provider, body);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(result),
    };
  } catch (error) {
    console.error('Webhook handler error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  } finally {
    await prisma.$disconnect();
  }
};

async function handleCallback(provider: PaymentProvider, callbackBody: any): Promise<any> {
  const result = await verifyAndParseCallback(provider, callbackBody);

  if (!result.orderCode) {
    console.error('Callback handling failed - no order code');
    return result.response;
  }

  if (result.success) {
    await handleSuccessPayment(result.orderCode);
  } else {
    await handleFailedPayment(result.orderCode);
  }

  return result.response;
}

async function verifyAndParseCallback(
  provider: PaymentProvider,
  body: any
): Promise<CallbackResult> {
  if (provider === PaymentProvider.ZALOPAY) {
    return verifyZaloPayCallback(body);
  } else if (provider === PaymentProvider.PAYOS) {
    return verifyPayOSCallback(body);
  }

  return { orderCode: null, success: false, response: { error: 'Unknown provider' } };
}

function verifyZaloPayCallback(body: any): CallbackResult {
  const { data, mac } = body;

  if (!data || !mac) {
    return { orderCode: null, success: false, response: { return_code: -1 } };
  }

  // Verify MAC
  const key2 = process.env.ZALOPAY_KEY2 || '';
  const expectedMac = crypto.createHmac('sha256', key2).update(data).digest('hex');

  if (mac !== expectedMac) {
    console.error('ZaloPay MAC verification failed');
    return { orderCode: null, success: false, response: { return_code: -1 } };
  }

  const dataJson = JSON.parse(data);
  const orderCode = dataJson.app_trans_id?.split('_')[1] || dataJson.app_trans_id;

  return {
    orderCode,
    success: true,
    response: { return_code: 1, return_message: 'success' },
  };
}

function verifyPayOSCallback(body: any): CallbackResult {
  const { data, signature } = body;

  if (!data || !signature) {
    return { orderCode: null, success: false, response: { error: 'Invalid payload' } };
  }

  // Verify signature
  const checksumKey = process.env.PAYOS_CHECKSUM_KEY || '';
  const sortedData = Object.keys(data)
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join('&');
  const expectedSignature = crypto.createHmac('sha256', checksumKey).update(sortedData).digest('hex');

  if (signature !== expectedSignature) {
    console.error('PayOS signature verification failed');
    return { orderCode: null, success: false, response: { error: 'Invalid signature' } };
  }

  return {
    orderCode: data.orderCode?.toString(),
    success: data.code === '00',
    response: { success: true },
  };
}

async function handleSuccessPayment(orderCode: string): Promise<void> {
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.update({
      where: { orderCode },
      data: { status: PaymentStatus.COMPLETED, completedAt: now },
    });

    // Save to outbox for Kafka publishing
    await tx.outbox.create({
      data: {
        aggregateId: payment.id,
        aggregateType: 'Payment',
        eventType: EventType.PAYMENT_COMPLETED,
        payload: {
          payment_id: payment.id,
          order_code: payment.orderCode,
          amount_cents: payment.amountCents,
          currency: payment.currency,
          provider: payment.provider,
          transaction_id: payment.providerTransactionId,
          completed_at: now.toISOString(),
        },
        published: false,
        retryCount: 0,
      },
    });

    return payment;
  });

  console.log(`Payment completed for order: ${orderCode}`);
}

async function handleFailedPayment(orderCode: string): Promise<void> {
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.update({
      where: { orderCode },
      data: { status: PaymentStatus.FAILED, failedAt: now },
    });

    // Save to outbox for Kafka publishing
    await tx.outbox.create({
      data: {
        aggregateId: payment.id,
        aggregateType: 'Payment',
        eventType: EventType.PAYMENT_FAILED,
        payload: {
          payment_id: payment.id,
          order_code: payment.orderCode,
          amount_cents: payment.amountCents,
          currency: payment.currency,
          provider: payment.provider,
          transaction_id: payment.providerTransactionId,
          failed_at: now.toISOString(),
        },
        published: false,
        retryCount: 0,
      },
    });

    return payment;
  });

  console.log(`Payment failed for order: ${orderCode}`);
}
