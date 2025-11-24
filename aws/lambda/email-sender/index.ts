/**
 * Email Sender Lambda
 *
 * Sends transactional emails via AWS SES
 * Triggered by EventBridge Pipes from Kafka topics
 *
 * Supported Events:
 * - payment.completed -> Order confirmation email
 * - ticket.issued -> E-ticket delivery email
 *
 * Environment Variables:
 * - SES_FROM_EMAIL: Sender email address
 * - SES_REGION: AWS region for SES
 * - S3_BUCKET_TICKETS: S3 bucket containing ticket PDFs
 */

import { SQSEvent, SQSRecord } from 'aws-lambda';
import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const ses = new SESClient({ region: process.env.SES_REGION || 'us-east-1' });
const s3 = new S3Client({});

const FROM_EMAIL = process.env.SES_FROM_EMAIL || 'noreply@ticketbottle.com';
const S3_BUCKET = process.env.S3_BUCKET_TICKETS || 'ticketbottle-tickets';

interface PaymentCompletedEvent {
  payment_id: string;
  order_code: string;
  amount_cents: number;
  currency: string;
  provider: string;
  transaction_id: string;
  completed_at: string;
  // Extended fields from order context
  customer_email?: string;
  customer_name?: string;
  event_name?: string;
  event_date?: string;
  tickets?: TicketInfo[];
}

interface TicketInfo {
  ticket_id: string;
  ticket_type: string;
  seat_info?: string;
}

export const handler = async (event: SQSEvent): Promise<void> => {
  console.log('Email sender triggered:', JSON.stringify(event));

  const results = await Promise.allSettled(
    event.Records.map((record) => processRecord(record))
  );

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    console.error(`${failed.length} emails failed to send`);
    // Throw to trigger SQS retry for failed messages
    throw new Error(`Failed to send ${failed.length} emails`);
  }

  console.log(`Successfully processed ${event.Records.length} email requests`);
};

async function processRecord(record: SQSRecord): Promise<void> {
  const body = JSON.parse(record.body);

  // EventBridge Pipes wraps the Kafka message
  const kafkaMessage = body.value ? JSON.parse(body.value) : body;
  const eventType = body.eventType || record.messageAttributes?.eventType?.stringValue;

  console.log(`Processing email for event type: ${eventType}`);

  switch (eventType) {
    case 'PAYMENT_COMPLETED':
      await sendOrderConfirmationEmail(kafkaMessage as PaymentCompletedEvent);
      break;
    case 'TICKET_ISSUED':
      await sendTicketEmail(kafkaMessage);
      break;
    default:
      console.warn(`Unknown event type: ${eventType}, skipping`);
  }
}

async function sendOrderConfirmationEmail(event: PaymentCompletedEvent): Promise<void> {
  if (!event.customer_email) {
    console.warn(`No customer email for order ${event.order_code}, skipping`);
    return;
  }

  const formattedAmount = formatCurrency(event.amount_cents, event.currency);

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #2563eb; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; background: #f9fafb; }
    .order-details { background: white; padding: 15px; border-radius: 8px; margin: 15px 0; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Order Confirmed!</h1>
    </div>
    <div class="content">
      <p>Hi ${event.customer_name || 'there'},</p>
      <p>Thank you for your purchase! Your payment has been successfully processed.</p>

      <div class="order-details">
        <h3>Order Details</h3>
        <p><strong>Order Code:</strong> ${event.order_code}</p>
        <p><strong>Amount:</strong> ${formattedAmount}</p>
        <p><strong>Event:</strong> ${event.event_name || 'N/A'}</p>
        <p><strong>Date:</strong> ${event.event_date || 'N/A'}</p>
        <p><strong>Payment Method:</strong> ${event.provider}</p>
      </div>

      <p>Your e-tickets will be sent in a separate email shortly.</p>
      <p>If you have any questions, please contact our support team.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} TicketBottle. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;

  const textBody = `
Order Confirmed!

Hi ${event.customer_name || 'there'},

Thank you for your purchase! Your payment has been successfully processed.

Order Details:
- Order Code: ${event.order_code}
- Amount: ${formattedAmount}
- Event: ${event.event_name || 'N/A'}
- Date: ${event.event_date || 'N/A'}
- Payment Method: ${event.provider}

Your e-tickets will be sent in a separate email shortly.

If you have any questions, please contact our support team.

© ${new Date().getFullYear()} TicketBottle. All rights reserved.
  `;

  await ses.send(
    new SendEmailCommand({
      Source: FROM_EMAIL,
      Destination: { ToAddresses: [event.customer_email] },
      Message: {
        Subject: { Data: `Order Confirmed - ${event.order_code}` },
        Body: {
          Html: { Data: htmlBody },
          Text: { Data: textBody },
        },
      },
    })
  );

  console.log(`Order confirmation email sent to ${event.customer_email}`);
}

async function sendTicketEmail(event: any): Promise<void> {
  if (!event.customer_email) {
    console.warn(`No customer email for ticket, skipping`);
    return;
  }

  // Fetch PDF from S3
  const pdfKey = `tickets/${event.order_code}/${event.ticket_id}.pdf`;

  try {
    const s3Response = await s3.send(
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: pdfKey,
      })
    );

    const pdfBuffer = await streamToBuffer(s3Response.Body as any);

    // Send email with PDF attachment
    await sendEmailWithAttachment(
      event.customer_email,
      `Your E-Ticket - ${event.event_name}`,
      buildTicketEmailBody(event),
      {
        filename: `ticket-${event.ticket_id}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }
    );

    console.log(`Ticket email sent to ${event.customer_email}`);
  } catch (error) {
    console.error(`Failed to send ticket email:`, error);
    throw error;
  }
}

async function sendEmailWithAttachment(
  to: string,
  subject: string,
  htmlBody: string,
  attachment: { filename: string; content: Buffer; contentType: string }
): Promise<void> {
  const boundary = `----=_Part_${Date.now()}`;

  const rawMessage = [
    `From: ${FROM_EMAIL}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
    '',
    `--${boundary}`,
    `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    '',
    attachment.content.toString('base64'),
    '',
    `--${boundary}--`,
  ].join('\r\n');

  await ses.send(
    new SendRawEmailCommand({
      RawMessage: { Data: Buffer.from(rawMessage) },
    })
  );
}

function buildTicketEmailBody(event: any): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #2563eb; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; background: #f9fafb; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Your E-Ticket</h1>
    </div>
    <div class="content">
      <p>Hi ${event.customer_name || 'there'},</p>
      <p>Please find your e-ticket attached to this email.</p>
      <p><strong>Event:</strong> ${event.event_name}</p>
      <p><strong>Date:</strong> ${event.event_date}</p>
      <p><strong>Ticket Type:</strong> ${event.ticket_type}</p>
      ${event.seat_info ? `<p><strong>Seat:</strong> ${event.seat_info}</p>` : ''}
      <p>Please present this ticket (printed or on your mobile device) at the venue entrance.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} TicketBottle. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;
}

function formatCurrency(amountCents: number, currency: string): string {
  const amount = amountCents / 100;
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: currency || 'VND',
  }).format(amount);
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
