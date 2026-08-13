const { query } = require('../config/db');
const { sendEmail } = require('./email');

// Emails the tenant's business address, and the staff member the lead is
// currently assigned to (if any), whenever a new lead comes in. Re-reads
// assigned_to fresh from the leads table so callers should run this after
// applyAssignmentRules has had a chance to assign the lead.
// No-ops silently if there's no address to send to.
const notifyNewLead = async ({ tenantId, lead }) => {
  const result = await query(
    `SELECT t.name AS tenant_name, t.email AS tenant_email,
            u.name AS staff_name, u.email AS staff_email
     FROM tenants t
     LEFT JOIN leads l ON l.id = $2
     LEFT JOIN users u ON u.id = l.assigned_to
     WHERE t.id = $1`,
    [tenantId, lead.id]
  );
  const row = result.rows[0];
  if (!row) return;

  const recipients = [...new Set([row.tenant_email, row.staff_email].filter(Boolean))];
  if (!recipients.length) return;

  const source = (lead.source || '').replace(/_/g, ' ');

  await Promise.all(recipients.map(to => sendEmail({
    to,
    fromName: row.tenant_name,
    subject: `New Lead: ${lead.name} 😁`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2>New Lead: ${lead.name} 😁</h2>
        <p><strong>Phone:</strong> ${lead.phone || '-'}</p>
        ${lead.email ? `<p><strong>Email:</strong> ${lead.email}</p>` : ''}
        ${source ? `<p><strong>Source:</strong> ${source}</p>` : ''}
        ${row.staff_name ? `<p><strong>Assigned to:</strong> ${row.staff_name}</p>` : ''}
        <p style="color: #999; font-size: 13px; margin-top: 24px;">Log in to CurveLead to view and respond to this lead.</p>
      </div>
    `,
    text: `New Lead: ${lead.name}\nPhone: ${lead.phone || '-'}${lead.email ? `\nEmail: ${lead.email}` : ''}${source ? `\nSource: ${source}` : ''}${row.staff_name ? `\nAssigned to: ${row.staff_name}` : ''}`,
  })));
};

module.exports = { notifyNewLead };
