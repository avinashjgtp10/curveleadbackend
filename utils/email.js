const nodemailer = require('nodemailer');

const createTransporter = () => {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD,
    },
  });
};

const sendEmail = async ({ to, subject, html, text }) => {
  try {
    if (!process.env.EMAIL_USER) {
      console.log(`📧 Email (dev) → ${to}: ${subject}`);
      return { success: true, dev: true };
    }

    const transporter = createTransporter();
    const result = await transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME || 'CurveLead'}" <${process.env.EMAIL_USER}>`,
      to, subject, html, text,
    });
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('Email error:', error.message);
    return { success: false, error: error.message };
  }
};

const sendPasswordResetEmail = async (email, resetUrl, businessName) => {
  return sendEmail({
    to: email,
    subject: 'Reset your password — CurveLead',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2>Reset Password</h2>
        <p>You requested a password reset. Click below to set a new password:</p>
        <a href="${resetUrl}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; margin: 20px 0;">Reset Password</a>
        <p style="color: #999; font-size: 13px;">Link expires in 1 hour. If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
};

module.exports = { sendEmail, sendPasswordResetEmail };
