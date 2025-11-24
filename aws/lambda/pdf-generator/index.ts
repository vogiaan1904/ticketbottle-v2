/**
 * PDF Generator Lambda
 *
 * Generates ticket PDFs with QR codes and stores them in S3
 * Triggered by EventBridge Pipes from ticket.issued Kafka topic
 *
 * Environment Variables:
 * - S3_BUCKET_TICKETS: S3 bucket for storing generated PDFs
 * - QR_CODE_BASE_URL: Base URL for QR code validation endpoint
 */

import { SQSEvent, SQSRecord } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

const s3 = new S3Client({});

const S3_BUCKET = process.env.S3_BUCKET_TICKETS || 'ticketbottle-tickets';
const QR_BASE_URL = process.env.QR_CODE_BASE_URL || 'https://api.ticketbottle.com/v1/tickets/validate';

interface TicketEvent {
  ticket_id: string;
  order_code: string;
  event_id: string;
  event_name: string;
  event_date: string;
  event_venue: string;
  ticket_type: string;
  seat_info?: string;
  customer_name: string;
  customer_email: string;
  qr_code_data: string;
  issued_at: string;
}

export const handler = async (event: SQSEvent): Promise<void> => {
  console.log('PDF generator triggered:', JSON.stringify(event));

  const results = await Promise.allSettled(
    event.Records.map((record) => processRecord(record))
  );

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    console.error(`${failed.length} PDFs failed to generate`);
    // Log detailed errors
    failed.forEach((f, i) => {
      if (f.status === 'rejected') {
        console.error(`PDF ${i} error:`, f.reason);
      }
    });
    throw new Error(`Failed to generate ${failed.length} PDFs`);
  }

  console.log(`Successfully generated ${event.Records.length} PDFs`);
};

async function processRecord(record: SQSRecord): Promise<void> {
  const body = JSON.parse(record.body);

  // EventBridge Pipes wraps the Kafka message
  const ticketEvent: TicketEvent = body.value ? JSON.parse(body.value) : body;

  console.log(`Generating PDF for ticket: ${ticketEvent.ticket_id}`);

  // Generate PDF
  const pdfBuffer = await generateTicketPDF(ticketEvent);

  // Upload to S3
  const s3Key = `tickets/${ticketEvent.order_code}/${ticketEvent.ticket_id}.pdf`;

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
      Metadata: {
        ticketId: ticketEvent.ticket_id,
        orderCode: ticketEvent.order_code,
        eventId: ticketEvent.event_id,
        generatedAt: new Date().toISOString(),
      },
    })
  );

  console.log(`PDF uploaded to s3://${S3_BUCKET}/${s3Key}`);
}

async function generateTicketPDF(ticket: TicketEvent): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A5',
        layout: 'landscape',
        margin: 30,
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Generate QR code
      const qrCodeUrl = `${QR_BASE_URL}?code=${ticket.qr_code_data}`;
      const qrCodeDataUrl = await QRCode.toDataURL(qrCodeUrl, {
        width: 150,
        margin: 1,
        errorCorrectionLevel: 'H',
      });

      // Header
      doc
        .fillColor('#2563eb')
        .fontSize(24)
        .font('Helvetica-Bold')
        .text('TICKETBOTTLE', 30, 30);

      doc.fillColor('#666').fontSize(10).font('Helvetica').text('E-TICKET', 30, 55);

      // Divider line
      doc
        .strokeColor('#e5e7eb')
        .lineWidth(1)
        .moveTo(30, 75)
        .lineTo(565, 75)
        .stroke();

      // Event details - Left side
      const leftX = 30;
      let currentY = 90;

      doc
        .fillColor('#111')
        .fontSize(18)
        .font('Helvetica-Bold')
        .text(ticket.event_name, leftX, currentY, { width: 350 });

      currentY += 35;

      doc
        .fillColor('#666')
        .fontSize(10)
        .font('Helvetica')
        .text('DATE & TIME', leftX, currentY);

      doc
        .fillColor('#111')
        .fontSize(12)
        .font('Helvetica-Bold')
        .text(formatDate(ticket.event_date), leftX, currentY + 12);

      currentY += 40;

      doc.fillColor('#666').fontSize(10).font('Helvetica').text('VENUE', leftX, currentY);

      doc
        .fillColor('#111')
        .fontSize(12)
        .font('Helvetica-Bold')
        .text(ticket.event_venue, leftX, currentY + 12, { width: 250 });

      currentY += 50;

      doc
        .fillColor('#666')
        .fontSize(10)
        .font('Helvetica')
        .text('TICKET TYPE', leftX, currentY);

      doc
        .fillColor('#111')
        .fontSize(12)
        .font('Helvetica-Bold')
        .text(ticket.ticket_type, leftX, currentY + 12);

      if (ticket.seat_info) {
        currentY += 35;
        doc.fillColor('#666').fontSize(10).font('Helvetica').text('SEAT', leftX, currentY);

        doc
          .fillColor('#2563eb')
          .fontSize(14)
          .font('Helvetica-Bold')
          .text(ticket.seat_info, leftX, currentY + 12);
      }

      // Right side - QR code and attendee info
      const rightX = 400;

      // QR Code
      const qrImage = qrCodeDataUrl.replace(/^data:image\/png;base64,/, '');
      doc.image(Buffer.from(qrImage, 'base64'), rightX, 90, { width: 130 });

      // Attendee info below QR
      doc.fillColor('#666').fontSize(10).font('Helvetica').text('ATTENDEE', rightX, 230);

      doc
        .fillColor('#111')
        .fontSize(11)
        .font('Helvetica-Bold')
        .text(ticket.customer_name, rightX, 242, { width: 150 });

      // Ticket ID
      doc
        .fillColor('#999')
        .fontSize(8)
        .font('Helvetica')
        .text(`Ticket ID: ${ticket.ticket_id}`, rightX, 260);

      // Footer
      doc
        .strokeColor('#e5e7eb')
        .lineWidth(1)
        .moveTo(30, 290)
        .lineTo(565, 290)
        .stroke();

      doc
        .fillColor('#999')
        .fontSize(8)
        .font('Helvetica')
        .text(
          'This ticket is valid for one-time entry only. Please present this ticket (printed or digital) at the venue.',
          30,
          300,
          { width: 400, align: 'left' }
        );

      doc
        .fillColor('#999')
        .fontSize(8)
        .text(`Issued: ${formatDate(ticket.issued_at)}`, 450, 300, { align: 'right' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
