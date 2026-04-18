const nodemailer = require('nodemailer');

// Create transporter based on env config
const createTransporter = () => {
  const service = process.env.EMAIL_SERVICE || 'gmail';

  if (service === 'gmail') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD, // Gmail App Password (not regular password)
      },
    });
  }

  // Generic SMTP
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
};

// Send email
const sendEmail = async ({ to, subject, html, text, attachments }) => {
  try {
    if (!process.env.EMAIL_USER && !process.env.SMTP_USER) {
      console.log(`📧 Email (dev mode) — To: ${to} | Subject: ${subject}`);
      if (html) console.log('   Body:', html.substring(0, 200) + '...');
      return { success: true, dev: true };
    }

    const transporter = createTransporter();
    const fromName = process.env.EMAIL_FROM_NAME || 'CurveLead';
    const fromEmail = process.env.EMAIL_USER || process.env.SMTP_USER;

    const result = await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject,
      html,
      text,
      attachments,
    });

    console.log(`✅ Email sent to ${to}: ${subject}`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('❌ Email error:', error.message);
    return { success: false, error: error.message };
  }
};

// Password Reset Email
const sendPasswordResetEmail = async (email, resetUrl, academyName) => {
  return sendEmail({
    to: email,
    subject: `Reset your password — ${academyName || 'CurveLead'}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="display: inline-block; background: #4f46e5; color: white; font-weight: bold; padding: 10px 16px; border-radius: 12px; font-size: 18px;">CL</div>
          <h2 style="margin-top: 12px; color: #111;">CurveLead</h2>
        </div>
        <p style="color: #555; font-size: 15px;">You requested a password reset. Click the button below to set a new password:</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${resetUrl}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px;">Reset Password</a>
        </div>
        <p style="color: #999; font-size: 13px;">This link expires in 1 hour. If you didn't request this, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
        <p style="color: #bbb; font-size: 12px; text-align: center;">CurveLead — Academy Management Platform</p>
      </div>
    `,
  });
};

// Fee Reminder Email
const sendFeeReminderEmail = async (to, studentName, amount, dueDate, academyName) => {
  return sendEmail({
    to,
    subject: `Fee Reminder — ₹${amount.toLocaleString('en-IN')} due — ${academyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #111;">Fee Reminder</h2>
        <p style="color: #555;">Dear ${studentName},</p>
        <p style="color: #555;">This is a reminder that your fee installment is due:</p>
        <div style="background: #f9fafb; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong>Amount:</strong> ₹${amount.toLocaleString('en-IN')}</p>
          <p style="margin: 4px 0;"><strong>Due Date:</strong> ${new Date(dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
        <p style="color: #555;">Please make the payment at the earliest. Contact us if you have any questions.</p>
        <p style="color: #555; margin-top: 20px;">Regards,<br/>${academyName}</p>
      </div>
    `,
  });
};

// Fee Receipt Email (with PDF attachment)
const sendReceiptEmail = async (to, studentName, receiptData, pdfBuffer, academyName) => {
  return sendEmail({
    to,
    subject: `Payment Receipt — ${receiptData.receipt_number} — ${academyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #111;">Payment Receipt</h2>
        <p style="color: #555;">Dear ${studentName},</p>
        <p style="color: #555;">Thank you for your payment. Please find your receipt attached.</p>
        <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong>Receipt No:</strong> ${receiptData.receipt_number}</p>
          <p style="margin: 4px 0;"><strong>Amount:</strong> ₹${parseFloat(receiptData.amount).toLocaleString('en-IN')}</p>
          <p style="margin: 4px 0;"><strong>Date:</strong> ${new Date(receiptData.payment_date).toLocaleDateString('en-IN')}</p>
          <p style="margin: 4px 0;"><strong>Mode:</strong> ${receiptData.payment_mode?.replace(/_/g, ' ')}</p>
        </div>
        <p style="color: #555;">Regards,<br/>${academyName}</p>
      </div>
    `,
    attachments: pdfBuffer ? [{
      filename: `Receipt_${receiptData.receipt_number}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }] : [],
  });
};

module.exports = { sendEmail, sendPasswordResetEmail, sendFeeReminderEmail, sendReceiptEmail };
