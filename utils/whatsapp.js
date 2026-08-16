// WhatsApp Business Cloud API integration
// Requires: WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN in .env

const sendWhatsAppMessage = async (to, message) => {
  try {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !accessToken) {
      console.log(`📱 WhatsApp (dev mode) — To: ${to} | Message: ${message}`);
      return { success: true, dev: true };
    }

    // Clean phone number
    let phone = to.replace(/\D/g, '');
    if (phone.length === 10) phone = '91' + phone; // Add India code

    const fetch = (await import('node-fetch')).default;
    const response = await fetch(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: message },
        }),
      }
    );

    const data = await response.json();
    if (data.error) {
      console.error('WhatsApp API error:', data.error);
      return { success: false, error: data.error.message };
    }

    console.log(`✅ WhatsApp sent to ${to}`);
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (error) {
    console.error('WhatsApp send error:', error.message);
    return { success: false, error: error.message };
  }
};

// Fee reminder template
const sendFeeReminder = async (phone, studentName, amount, dueDate, businessName) => {
  const message = `🎓 *${businessName}*\n\nDear ${studentName},\n\nThis is a reminder that your fee installment of *₹${amount.toLocaleString('en-IN')}* is due on *${new Date(dueDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}*.\n\nPlease make the payment at the earliest.\n\nThank you! 🙏`;
  return sendWhatsAppMessage(phone, message);
};

// Payment confirmation
const sendPaymentConfirmation = async (phone, studentName, amount, receiptNo, businessName) => {
  const message = `🎓 *${businessName}*\n\n✅ Payment Received!\n\nDear ${studentName},\n\nWe have received your payment of *₹${amount.toLocaleString('en-IN')}*.\n\nReceipt No: ${receiptNo}\n\nThank you! 🙏`;
  return sendWhatsAppMessage(phone, message);
};

// Lead follow-up reminder to staff
const sendLeadFollowupReminder = async (phone, leadName, leadPhone, staffName) => {
  const message = `📋 *Follow-up Reminder*\n\nHi ${staffName},\n\nPlease follow up with:\n*${leadName}* — ${leadPhone}\n\nDon't let this lead slip away! 💪`;
  return sendWhatsAppMessage(phone, message);
};

module.exports = { sendWhatsAppMessage, sendFeeReminder, sendPaymentConfirmation, sendLeadFollowupReminder };
