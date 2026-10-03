const queues = require('./queues');
const { ingestWebhookLead, backfillForm } = require('../services/metaLeads');

// Lead Ads jobs: one per lead announced by the webhook, and per-form backfills.
const registerMetaLeadJobs = () => {
  queues.register('leads:ingest-meta', (data) => ingestWebhookLead(data), { attempts: 5, backoffMs: 30000, concurrency: 3 });
  queues.register('leads:backfill-form', (data) => backfillForm(data), { attempts: 2, backoffMs: 60000, concurrency: 1 });
};

module.exports = { registerMetaLeadJobs };
