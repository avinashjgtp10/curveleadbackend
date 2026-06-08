const axios = require('axios');

const META_API_URL = 'https://graph.facebook.com/v18.0';

/**
 * Send WhatsApp text message
 */
const sendTextMessage = async (to, message) => {
  if (!process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.WHATSAPP_ACCESS_TOKEN) {
    console.log(`📱 WhatsApp (dev) → ${to}: ${message}`);
    return { success: true, dev: true, wa_message_id: `dev_${Date.now()}` };
  }

  let phone = to.replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone;

  try {
    const response = await axios.post(
      `${META_API_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: message },
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return {
      success: true,
      wa_message_id: response.data.messages?.[0]?.id,
    };
  } catch (error) {
    console.error('WhatsApp send error:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.error?.message || error.message };
  }
};

/**
 * Send WhatsApp template message (for first contact, marketing)
 */
const sendTemplate = async (to, templateName, languageCode = 'en', parameters = []) => {
  if (!process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.WHATSAPP_ACCESS_TOKEN) {
    console.log(`📱 WhatsApp Template (dev) → ${to}: ${templateName}`);
    return { success: true, dev: true };
  }

  let phone = to.replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone;

  try {
    const response = await axios.post(
      `${META_API_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: parameters.length ? [{ type: 'body', parameters }] : undefined,
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return { success: true, wa_message_id: response.data.messages?.[0]?.id };
  } catch (error) {
    console.error('WhatsApp template error:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.error?.message || error.message };
  }
};

module.exports = { sendTextMessage, sendTemplate };
