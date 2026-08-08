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

const sendEmail = async ({ to, subject, html, text, fromName }) => {
  try {
    if (!process.env.EMAIL_USER) {
      console.log(`📧 Email (dev) → ${to}: ${subject}`);
      return { success: true, dev: true };
    }

    const transporter = createTransporter();
    const result = await transporter.sendMail({
      from: `"${fromName || process.env.EMAIL_FROM_NAME || 'CurveLead'}" <${process.env.EMAIL_USER}>`,
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

const sendInviteEmail = async (email, inviteUrl, businessName, inviterName) => {
  return sendEmail({
    to: email,
    fromName: businessName,
    subject: `${inviterName} invited you to join ${businessName} on CurveLead`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2>You're invited to ${businessName}</h2>
        <p>${inviterName} has invited you to join their team on CurveLead. Click below to set up your account:</p>
        <a href="${inviteUrl}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; margin: 20px 0;">Accept Invitation</a>
        <p style="color: #999; font-size: 13px;">This link expires in 7 days.</p>
      </div>
    `,
  });
};

module.exports = { sendEmail, sendPasswordResetEmail, sendInviteEmail };
