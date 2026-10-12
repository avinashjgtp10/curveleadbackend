const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { costPerLead } = require('../services/ctwaCost');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('Click-to-WhatsApp cost per lead: only a trustworthy figure is given, and always with a reason when not', () => {
  assert.deepEqual(costPerLead([{ currency: 'INR', spend: 1000 }], 10), { spend: 1000, currency: 'INR', cost_per_lead: 100, reason: null });
  assert.deepEqual(costPerLead([{ currency: 'INR', spend: 100.005 }, { currency: 'INR', spend: 200.005 }], 3).cost_per_lead, 100.01);
  assert.equal(costPerLead([], 10).reason, 'not_measured');
  assert.equal(costPerLead(undefined, 10).reason, 'not_measured');
  assert.equal(costPerLead([{ currency: 'INR', spend: 0 }], 10).reason, 'no_spend');
  assert.equal(costPerLead([{ currency: 'INR', spend: 500 }], 0).reason, 'no_leads');
  const mixed = costPerLead([{ currency: 'INR', spend: 500 }, { currency: 'USD', spend: 10 }], 5);
  assert.equal(mixed.reason, 'mixed_spend_currencies'); assert.equal(mixed.cost_per_lead, null); assert.deepEqual(mixed.spend_by_currency, { INR: 500, USD: 10 });
});

test('Meta test leads are recognised by the testing tool placeholder and by nothing else', () => {
  process.env.DB_HOST = '127.0.0.1'; process.env.DB_SSL = 'false';
  const { isMetaTestLead } = require('../services/metaLeads');
  const f = (...v) => ({ field_data: v.map((x, i) => ({ name: `f${i}`, values: [x] })) });
  assert.equal(isMetaTestLead(f('<test lead: dummy data for full_name>', '<test lead: dummy data for phone_number>')), true);
  assert.equal(isMetaTestLead(f('Real Person', ' <TEST LEAD: dummy data for email>')), true, 'any one placeholder answer is enough');
  assert.equal(isMetaTestLead(f('Real Person', '+919999999999', 'test@example.com')), false);
  assert.equal(isMetaTestLead(f('I am not a test lead <test lead')), false, 'only a value that STARTS with the placeholder');
  assert.equal(isMetaTestLead({}), false);
});

test('the flag is written to the lead, is optional-column safe, and the CTWA endpoint ignores test leads and lifetime spend', () => {
  assert.match(read('services/metaLeads.js'), /\.\.\.\(isMetaTestLead\(lead\) \? \{ is_test_lead: true \} : \{\}\)/);
  assert.match(read('services/leadIngestion.js'), /OPTIONAL_COLUMNS = \['meta_form_id', 'is_test_lead'\]/);
  const hub = read('controllers/whatsappHubController.js');
  assert.equal((hub.match(/to_jsonb\(l\)->>'is_test_lead'/g) || []).length, 3, 'summary, campaigns and recent all skip test leads');
  assert.doesNotMatch(hub, /c\.actual_spend|parseFloat\(r\.actual_spend\)/, 'no lifetime spend in the cost per lead');
  assert.match(hub, /costPerLead\(spendRows\.filter/);
});

test('the daily email digest does not count test leads against a campaign', () => {
  assert.match(read('jobs/dailyReportEmail.js'), /LEFT JOIN leads l ON l\.campaign_id = c\.id AND l\.merged_into_id IS NULL\s+AND NOT COALESCE\(\(to_jsonb\(l\)->>'is_test_lead'\)::boolean, false\)/);
});
