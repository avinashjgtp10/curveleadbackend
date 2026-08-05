const { query } = require('../config/db');
const { sendEmail } = require('./email');

// Emails the tenant's business address whenever a new lead comes in.
// No-ops silently if the tenant has no email on file.
const notifyNewLead = async ({ tenantId, lead }) => {
  const result = await query('SELECT name, email FROM tenants WHERE id = $1', [tenantId]);
  const tenant = result.rows[0];
  if (!tenant?.email) return;

  const source = (lead.source || '').replace(/_/g, ' ');

  await sendEmail({
    to: tenant.email,
    fromName: tenant.name,
    subject: `New Lead: ${lead.name} 😁`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2>New Lead: ${lead.name} 😁</h2>
        <p><strong>Phone:</strong> ${lead.phone || '-'}</p>
        ${lead.email ? `<p><strong>Email:</strong> ${lead.email}</p>` : ''}
        ${source ? `<p><strong>Source:</strong> ${source}</p>` : ''}
        <p style="color: #999; font-size: 13px; margin-top: 24px;">Log in to CurveLead to view and respond to this lead.</p>
      </div>
    `,
    text: `New Lead: ${lead.name}\nPhone: ${lead.phone || '-'}${lead.email ? `\nEmail: ${lead.email}` : ''}${source ? `\nSource: ${source}` : ''}`,
  });
};

module.exports = { notifyNewLead };
