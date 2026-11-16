// Releases unused call authorizations and flags calls that never reported an end. Runs every minute.
const { isSchemaError } = require('../utils/schemaErrors');

let warnedMissingSchema = false;

const runVoiceCallingSweep = async () => {
  try {
    const out = await require('../services/voiceCalling').services().calls.expireStale();
    warnedMissingSchema = false;
    if (out.expired || out.stuck) console.log(JSON.stringify({ evt: 'voice.sweep', ...out }));
  } catch (e) {
    // Database behind the code (voice_calling migration not run): say so once, not every minute.
    if (isSchemaError(e)) {
      if (!warnedMissingSchema) {
        warnedMissingSchema = true;
        console.warn(`MIGRATION_PENDING: run models/migration_voice_calling.sql; voice sweep is skipped until then (${e.message})`);
      }
      return;
    }
    console.error('Voice sweep failed:', e.message);
  }
};
module.exports = { runVoiceCallingSweep };
