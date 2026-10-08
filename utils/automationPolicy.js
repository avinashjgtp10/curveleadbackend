const MAX_ATTEMPTS = 4;
const normalizeAnswer = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
function matchRoute(routes, text) {
  const answer = normalizeAnswer(text);
  // Digits must match a configured answer exactly; never search within a sentence.
  const matches = routes.filter(r => [r.answer, ...(r.aliases || [])].some(a => normalizeAnswer(a) === answer));
  return matches.length === 1 ? { route: matches[0] } : { review: true, reason: matches.length ? 'Ambiguous reply: multiple routes match.' : 'Reply does not match a configured answer or alias.' };
}
function stopReason(lead, conditions = {}) {
  if (lead.opted_out) return 'opted_out';
  if (lead.is_lost) return 'stage_lost';
  if (conditions.customer_converted && (lead.won_at || lead.is_won)) return 'customer_converted';
  if (conditions.demo_booked && lead.has_demo) return 'demo_booked';
  return null;
}
function sendOutcome(result, attempts) {
  if (result?.success && !result.dev && result.wa_message_id) return { status: 'sent' };
  if (result?.uncertain || result?.success || !result) return { status: 'uncertain', reason: result?.error || 'Delivery outcome unknown; reconcile with the provider before retrying.' };
  if (result.transient && attempts < MAX_ATTEMPTS) return { status: 'retry', minutes: Math.min(60, 5 * (2 ** (attempts - 1))), reason: result.error };
  return { status: 'failed', reason: result.error || 'Send failed.' };
}
function templatePlan(step, templates, lead, media) {
  const candidates = templates.filter(t => t.name === step.approved_template_name && t.status === 'APPROVED');
  const template = step.template_language ? candidates.find(t => t.language === step.template_language) : candidates.length === 1 ? candidates[0] : null;
  if (!template) return { blocked: 'Approved template missing, unapproved, or language ambiguous. Select its exact language.' };
  const body = template.components?.find(c => c.type === 'BODY');
  if(/\{\{(?!\d+\}\})/.test(body?.text || ''))return {blocked:'Only numbered body parameters are supported.'};
  const slots = [...new Set([...String(body?.text || '').matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].sort((a,b) => a-b);
  if (slots.some((n,i) => n !== i+1)) return { blocked: 'Template body parameter numbering is unsupported.' };
  const mapping = step.template_parameters || [];
  // Preserve old single-name/multi-name fallback behaviour when no mapping exists.
  if (mapping.length && mapping.length !== slots.length) return { blocked: 'Template body parameter count does not match the mapping.' };
  const parameters = slots.map((n,i) => {
    const m = mapping[i] || { field: 'name' };
    const value = m.field === 'literal' ? m.value : lead[m.field];
    return { type:'text', text: String(value || (m.field === 'name' ? 'there' : '')).trim() };
  });
  if (parameters.some(p => !p.text)) return { blocked:'A required template parameter has no value.' };
  const header = template.components?.find(c => c.type === 'HEADER');
  if (header && ['IMAGE','VIDEO','DOCUMENT'].includes(header.format) && (!media?.link || media.type?.toUpperCase() !== header.format)) return { blocked:'Template media header is not configured.' };
  if (header?.format === 'TEXT' && /\{\{/.test(header.text || '')) return { blocked:'Variable text headers are not supported.' };
  if (template.components?.some(c => c.type === 'BUTTONS' && c.buttons?.some(b => /\{\{/.test(b.url || '') || b.type === 'COPY_CODE'))) return { blocked:'Dynamic button parameters are not supported.' };
  let message = body?.text || `[Template: ${template.name}]`;
  parameters.forEach((p,i) => { message = message.replace(new RegExp(`\\{\\{${i+1}\\}\\}`, 'g'), () => p.text); });
  return { template, parameters, message, language: template.language };
}
function validateSequence(body) {
  if (body.stop_conditions && (typeof body.stop_conditions !== 'object' || Array.isArray(body.stop_conditions) || Object.entries(body.stop_conditions).some(([k,v]) => !['on_reply','demo_booked','customer_converted'].includes(k) || typeof v !== 'boolean'))) return 'Invalid stop conditions.';
  if (!Array.isArray(body.steps) || !body.steps.length || body.steps.length > 30) return 'A sequence needs 1–30 steps.';
  let questions = 0;
  for (const [i,s] of body.steps.entries()) {
    if (!s || typeof s !== 'object' || (s.always_template !== undefined && typeof s.always_template !== 'boolean')) return 'Invalid step.';
    if (s.reply_routes != null && !Array.isArray(s.reply_routes)) return 'Reply routes must be an array.';
    if (!Number.isInteger(s.delay_minutes) || s.delay_minutes < 0 || s.delay_minutes > 525600) return `Step ${i+1}: invalid delay.`;
    if (!['whatsapp','email'].includes(s.channel || 'whatsapp')) return 'Invalid step channel.';
    if (s.always_template && (s.channel !== 'whatsapp' || !s.approved_template_name?.trim() || !s.template_language?.trim())) return 'Always-template steps need a WhatsApp template and language.';
    if (!s.always_template && !s.ai_generated && !s.message?.trim()) return `Step ${i+1} needs a message.`;
    if (s.template_parameters && (!Array.isArray(s.template_parameters) || s.template_parameters.some(m => !m || !['name','phone','email','location','source','product','literal'].includes(m.field) || (m.field === 'literal' && !m.value?.trim())))) return 'Invalid template parameter mapping.';
    if (s.reply_routes?.length) {
      questions++;
      if (s.channel !== 'whatsapp' || questions > 1 || !Array.isArray(s.reply_routes) || s.reply_routes.length > 20) return 'Only one WhatsApp reply question is supported per sequence.';
      const seen = new Set();
      for (const r of s.reply_routes) {
        if (!r || typeof r.answer!=='string' || typeof r.classification!=='string' || !r.answer?.trim() || !r.classification?.trim() || r.classification.length > 100 || !/^[0-9a-f-]{36}$/i.test(r.sequence_id || '') || !Array.isArray(r.aliases || [])) return 'Each route needs an answer, classification and target sequence.';
        for (const alias of [r.answer, ...(r.aliases || [])]) {
          if (typeof alias !== 'string' || !normalizeAnswer(alias) || seen.has(normalizeAnswer(alias))) return 'Reply answers and aliases must be unique and nonempty.';
          seen.add(normalizeAnswer(alias));
        }
      }
    }
  }
  return null;
}
module.exports = { MAX_ATTEMPTS, normalizeAnswer, matchRoute, stopReason, sendOutcome, templatePlan, validateSequence };
