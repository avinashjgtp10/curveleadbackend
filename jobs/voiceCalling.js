// Releases unused call authorizations and flags calls that never reported an end. Runs every minute.
const runVoiceCallingSweep = async () => {
  try {
    const out = await require('../services/voiceCalling').services().calls.expireStale();
    if (out.expired || out.stuck) console.log(JSON.stringify({ evt: 'voice.sweep', ...out }));
  } catch (e) { console.error('Voice sweep failed:', e.message); }
};
module.exports = { runVoiceCallingSweep };
