// Stops the AI auto-reply from talking to another business's bot (Batch 1 C).
// Trigger: the new inbound looks automated (auto-reply phrasing, or a repeat of one of the
// contact's last 3 messages) AND the AI has already answered 3 such automated-looking
// messages in a row with no human message in between. Timing alone never triggers it.

const AUTOMATED_PATTERNS = [
  /thank(s| you) for (contacting|reaching out|your message|messaging|getting in touch)/i,
  /we('ll| will) (get back|reply|respond|revert|contact you)/i,
  /(this is an? )?(automated|automatic|auto[- ]?generated|auto[- ]?reply|autoreply)/i,
  /\b(out of (the )?office|currently (closed|unavailable|away)|outside (our )?(business|working) hours)\b/i,
  /\b(our|business|working|office) hours\b/i,
  /how (can|may) (i|we) (help|assist) you( today)?\??/i,
  /\bwelcome to\b/i,
  /\b(reply|type|press|send) (with )?(1|2|3|menu|hi|start)\b/i,
  /please (select|choose) (an|one) option/i,
  /our (team|executive|representative) will (contact|call|get in touch)/i,
  /आपका स्वागत है|संपर्क करने के लिए धन्यवाद|हम (जल्द|शीघ्र) ही|स्वचालित संदेश/,
  /आपले स्वागत आहे|संपर्क केल्याबद्दल धन्यवाद|आम्ही लवकरच|स्वयंचलित संदेश/,
  /aapka swagat hai|sampark karne ke liye dhanyavad|hum jald hi/i,
];

const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

const looksAutomated = (text, priorInbound = []) => {
  const t = norm(text);
  if (!t) return false;
  if (AUTOMATED_PATTERNS.some((re) => re.test(text))) return true;
  return priorInbound.slice(0, 3).some((p) => norm(p) === t);
};

// history: messages newest first, NOT including the current inbound:
// [{ direction, message, is_ai_generated, is_automated }]
const consecutiveAutomatedAiTurns = (history) => {
  let turns = 0;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.direction !== 'outbound' || !m.is_ai_generated) break;           // a human (or nothing) answered last
    const trigger = history.slice(i + 1).find((x) => x.direction === 'inbound');
    if (!trigger) break;
    const olderInbound = history.slice(history.indexOf(trigger) + 1).filter((x) => x.direction === 'inbound').map((x) => x.message);
    if (!looksAutomated(trigger.message, olderInbound)) break;
    turns++;
    i = history.indexOf(trigger);                                            // continue below that inbound
  }
  return turns;
};

const MAX_AUTOMATED_AI_TURNS = 3;

const shouldPauseAi = ({ text, history }) => {
  const priorInbound = history.filter((m) => m.direction === 'inbound').map((m) => m.message);
  return looksAutomated(text, priorInbound) && consecutiveAutomatedAiTurns(history) >= MAX_AUTOMATED_AI_TURNS;
};

// Word-set similarity, for "don't send the same confirmation twice".
const similarity = (a, b) => {
  const A = new Set(norm(a).split(/[^\p{L}\p{N}]+/u).filter(Boolean)), B = new Set(norm(b).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
};
const isRepeatOf = (reply, previous) => !!previous && (norm(reply) === norm(previous) || similarity(reply, previous) >= 0.85);

module.exports = { AUTOMATED_PATTERNS, looksAutomated, consecutiveAutomatedAiTurns, shouldPauseAi, MAX_AUTOMATED_AI_TURNS, similarity, isRepeatOf };
