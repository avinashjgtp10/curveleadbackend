// Tax and bank fields a business in each country actually has (Batch 1 E).
// tenants.gst_number holds the primary tax registration number whatever its local name
// (GSTIN, TRN, VAT, EIN…); pan_number is India-only. Bank fields live in settings.bank_details.
// Keep in sync with frontend src/utils/locale.js.
const HOLDER = { key: 'account_holder', label: 'Account holder name' };
const BANK = { key: 'bank_name', label: 'Bank name' };
const ACCOUNT = { key: 'account_number', label: 'Account number' };
const IBAN = { key: 'iban', label: 'IBAN' };
const SWIFT = { key: 'swift', label: 'SWIFT / BIC' };

const GULF = { tax: [{ key: 'gst_number', label: 'TRN (VAT registration)' }], bank: [HOLDER, BANK, IBAN, SWIFT], default_tax_percent: 5 };
const EU = (vat) => ({ tax: [{ key: 'gst_number', label: 'VAT number' }], bank: [HOLDER, BANK, IBAN, SWIFT], default_tax_percent: vat });

const PROFILES = {
  IN: { tax: [{ key: 'gst_number', label: 'GSTIN' }, { key: 'pan_number', label: 'PAN' }],
        bank: [HOLDER, BANK, ACCOUNT, { key: 'ifsc', label: 'IFSC code' }, { key: 'upi', label: 'UPI ID' }], default_tax_percent: 18 },
  AE: GULF, SA: { ...GULF, default_tax_percent: 15 }, OM: GULF, BH: { ...GULF, default_tax_percent: 10 }, QA: { ...GULF, default_tax_percent: 0 }, KW: { ...GULF, default_tax_percent: 0 },
  GB: { tax: [{ key: 'gst_number', label: 'VAT number' }], bank: [HOLDER, BANK, ACCOUNT, { key: 'sort_code', label: 'Sort code' }, IBAN, SWIFT], default_tax_percent: 20 },
  IE: EU(23), DE: EU(19), FR: EU(20), NL: EU(21), ES: EU(21), IT: EU(22),
  US: { tax: [{ key: 'gst_number', label: 'EIN' }], bank: [HOLDER, BANK, ACCOUNT, { key: 'routing_number', label: 'Routing number (ABA)' }, SWIFT], default_tax_percent: 0 },
  CA: { tax: [{ key: 'gst_number', label: 'Business number (GST/HST)' }], bank: [HOLDER, BANK, ACCOUNT, { key: 'transit_number', label: 'Transit & institution number' }, SWIFT], default_tax_percent: 5 },
  AU: { tax: [{ key: 'gst_number', label: 'ABN' }], bank: [HOLDER, BANK, ACCOUNT, { key: 'bsb', label: 'BSB' }, SWIFT], default_tax_percent: 10 },
  NZ: { tax: [{ key: 'gst_number', label: 'GST number' }], bank: [HOLDER, BANK, ACCOUNT, SWIFT], default_tax_percent: 15 },
  SG: { tax: [{ key: 'gst_number', label: 'GST registration number' }], bank: [HOLDER, BANK, ACCOUNT, SWIFT], default_tax_percent: 9 },
};
const DEFAULT_PROFILE = { tax: [{ key: 'gst_number', label: 'Tax ID' }], bank: [HOLDER, BANK, ACCOUNT, IBAN, SWIFT], default_tax_percent: 0 };

const countryProfile = (country) => PROFILES[country] || DEFAULT_PROFILE;

// Label for a bank_details key; falls back to a tidied key so nothing saved is ever hidden.
const bankLabel = (country, key) => countryProfile(country).bank.find(f => f.key === key)?.label
  || ({ ifsc: 'IFSC', upi: 'UPI' }[key]) || key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

module.exports = { countryProfile, bankLabel, PROFILES };
