const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

/**
 * Call Groq API with a prompt
 */
const callGroq = async (messages, options = {}) => {
  if (!process.env.GROQ_API_KEY) {
    console.warn('⚠️ GROQ_API_KEY not set, returning mock response');
    return { content: '{"score":"warm","reason":"AI disabled - default score"}' };
  }

  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: options.model || DEFAULT_MODEL,
        messages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens || 500,
        response_format: options.json ? { type: 'json_object' } : undefined,
        // gpt-oss models reason before answering; without capping effort, that
        // reasoning can consume the whole max_tokens budget and leave an empty
        // response. 'low' keeps replies snappy for these short, simple prompts.
        reasoning_effort: options.reasoningEffort || 'low',
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    return { content: response.data.choices[0].message.content };
  } catch (error) {
    console.error('Groq API error:', error.response?.data || error.message);
    throw new Error('AI service temporarily unavailable');
  }
};

/**
 * AI Qualification Bot - reply to incoming WhatsApp message
 */
const qualifyLead = async (leadName, messageHistory, latestMessage, businessContext) => {
  const conversationContext = messageHistory.map(m =>
    `${m.direction === 'inbound' ? 'Lead' : 'You'}: ${m.message}`
  ).join('\n');

  const k = businessContext.knowledge || {};
  const section = (title, text) => (text && text.trim() ? `\n${title}:\n${text.trim()}\n` : '');
  const knowledgeBlock = [
    section('About the business', k.about),
    section('Services and prices (only quote what is listed here; never invent prices)', k.services_prices),
    section('FAQs (answer from these)', k.faqs),
    section('Tone and style', k.tone),
    section('Main goal of every conversation', k.goal),
    section('Never say or promise', k.never_say),
    section('Hand off to a human (should_human_takeover = true) when', k.handoff_rules),
    section('Examples of good conversations to imitate', k.example_chats),
    businessContext.lead_source ? `\nHow this lead found us: ${businessContext.lead_source}\n` : '',
  ].join('');

  const prompt = `You are a friendly sales assistant for ${businessContext.business_name || 'our business'}.

Business context: ${businessContext.description || 'We help businesses with their needs.'}
${knowledgeBlock}
You are chatting with a potential customer named ${leadName} via WhatsApp.

Previous conversation:
${conversationContext || '(no previous messages)'}

Latest message from ${leadName}: "${latestMessage}"

Your task:
1. Reply naturally and warmly (max 2-3 sentences)
2. Try to qualify the lead by understanding: their need, timeline, budget
3. If they seem interested, suggest a call or demo
4. If they say "not interested", politely close the conversation
5. Keep tone professional but friendly, use light emojis sparingly

Respond ONLY with valid JSON:
{
  "reply": "your message to send",
  "intent": "interested|not_interested|needs_info|ready_to_buy|unclear",
  "should_human_takeover": true|false,
  "suggested_action": "schedule_call|send_pricing|send_demo|close_conversation|continue"
}`;

  const result = await callGroq(
    [{ role: 'user', content: prompt }],
    { json: true, temperature: 0.7 }
  );

  try {
    return JSON.parse(result.content);
  } catch (e) {
    return {
      reply: `Hi ${leadName}! Thanks for your message. A team member will get back to you shortly.`,
      intent: 'unclear',
      should_human_takeover: true,
      suggested_action: 'continue',
    };
  }
};

/**
 * Compose one AI-personalized WhatsApp follow-up message for a scheduled
 * automation step. Returns null (never throws) on empty/unusable output —
 * caller treats null the same as a failure and skips sending rather than
 * risk sending something broken.
 */
const generateFollowUpMessage = async ({
  leadName, tenantName, businessDescription, instructions, conversationHistory,
}) => {
  if (!process.env.GROQ_API_KEY) return null;

  const conversationContext = (conversationHistory || []).map(m =>
    `${m.direction === 'inbound' ? leadName : 'You'}: ${m.message}`
  ).join('\n');

  const prompt = `You are writing a single WhatsApp follow-up message on behalf of ${tenantName || 'our business'}.

Business context: ${businessDescription || 'We help businesses with their needs.'}

Lead: ${leadName}

${conversationContext ? `Recent conversation:\n${conversationContext}\n` : '(No previous conversation with this lead yet.)'}

Instructions from the business owner for this follow-up: "${instructions || 'Write a friendly, natural check-in.'}"

Write ONE short WhatsApp message (max 3 short lines, under ~40 words) that:
- Follows the business owner's instructions above
- Sounds like a real person, not a template — personalize it using the lead's name and the conversation above where relevant
- Does not repeat anything already said earlier in the conversation
- Uses at most one emoji, only if it fits naturally
- Ends with a soft, low-pressure next step if appropriate

Respond with ONLY the message text itself — no quotation marks, no labels like "Message:", no explanation, no markdown.`;

  try {
    const result = await callGroq([{ role: 'user', content: prompt }], { temperature: 0.6, maxTokens: 200 });
    const text = (result.content || '').trim().replace(/^["']|["']$/g, '');
    return text || null;
  } catch (e) {
    console.error('generateFollowUpMessage error:', e.message);
    return null;
  }
};

/**
 * Summarize lead conversation for sales rep
 */
const summarizeLead = async (leadData, messages, activities) => {
  const conversationText = messages.map(m =>
    `[${new Date(m.sent_at).toLocaleDateString()}] ${m.direction === 'inbound' ? 'Lead' : 'Us'}: ${m.message}`
  ).join('\n');

  const prompt = `Summarize this lead's journey in 2-3 bullet points for a sales rep.

Lead: ${leadData.name} (${leadData.phone})
Source: ${leadData.source}
Stage: ${leadData.stage}
Days in pipeline: ${Math.floor((Date.now() - new Date(leadData.created_at)) / (1000 * 60 * 60 * 24))}

Recent conversation:
${conversationText.substring(0, 2000)}

Provide:
- What they're interested in
- Current status / blockers
- Recommended next action

Be concise, action-oriented.`;

  const result = await callGroq([{ role: 'user', content: prompt }], { temperature: 0.4 });
  return result.content;
};

/**
 * Market Intelligence — competitor & market analysis
 */
const analyzeMarket = async ({ business_name, industry, product_service, target_geography, customer_type }) => {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('AI service not configured. Please set GROQ_API_KEY in your server environment.');
  }

  const prompt = `You are a world-class market research analyst and business strategist with deep knowledge of global markets.

Analyze the market for this business and provide a comprehensive, actionable report:

Business: ${business_name}
Industry: ${industry}
Product/Service: ${product_service}
Target Geography: ${target_geography || 'Global'}
Customer Type: ${customer_type || 'SMBs and Enterprises'}

Provide a detailed market analysis in this exact JSON format (no extra text, only valid JSON):
{
  "market_overview": {
    "summary": "3-4 sentence overview of this market globally",
    "estimated_size": "estimated global market size (e.g. $12B)",
    "growth_rate": "annual growth rate (e.g. 14% CAGR)",
    "maturity": "Emerging | Growing | Mature | Declining",
    "key_trends": [
      "trend 1 shaping this market",
      "trend 2",
      "trend 3",
      "trend 4"
    ]
  },
  "top_competitors": [
    {
      "name": "Competitor Name",
      "origin": "Country",
      "market_position": "Leader | Challenger | Niche",
      "strengths": ["strength 1", "strength 2"],
      "weaknesses": ["weakness 1", "weakness 2"],
      "differentiator": "what makes them unique in one line"
    }
  ],
  "opportunities": [
    {
      "title": "Opportunity title",
      "description": "1-2 sentence explanation of this market opportunity"
    }
  ],
  "threats": [
    {
      "title": "Threat title",
      "description": "1-2 sentence explanation of this threat"
    }
  ],
  "recommendations": [
    {
      "priority": "High | Medium",
      "action": "Specific action to take",
      "rationale": "Why this matters"
    }
  ],
  "ideal_customer_profile": "Description of the ideal customer for this business in 2 sentences"
}

Include 5-8 real competitors, 4-5 opportunities, 3-4 threats, and 4-5 recommendations. Be specific and factual.`;

  const result = await callGroq(
    [{ role: 'user', content: prompt }],
    { json: true, temperature: 0.4, maxTokens: 3000 }
  );

  try {
    return JSON.parse(result.content);
  } catch (e) {
    throw new Error('Failed to parse market analysis response');
  }
};

/**
 * Transcribe audio/video using Groq Whisper
 * buffer must be a Buffer, filename is the original file name
 */
const transcribeAudio = async (buffer, filename, mimetype) => {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');

  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimetype });
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'text');

  const response = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      timeout: 180000, // 3 min — long audio files take time
      maxBodyLength: 26 * 1024 * 1024,
      maxContentLength: 26 * 1024 * 1024,
    }
  );
  return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
};

/**
 * Analyze a call/demo transcript and score the pitch
 */
const analyzeRecording = async ({ transcription, recordingType, leadName, staffName }) => {
  const prompt = `You are an expert sales coach reviewing a ${recordingType === 'video' ? 'demo recording' : 'sales call'} transcript.

Rep: ${staffName || 'Unknown'}
Lead: ${leadName || 'Unknown'}

Transcript:
"""
${transcription.slice(0, 6000)}
"""

Analyze the transcript and respond ONLY with valid JSON:
{
  "overall_score": <number 1-10>,
  "pitch_covered": ["element that was done", "another element"],
  "pitch_missed": ["missed element", "another missed element"],
  "strengths": ["specific strength observed in this call"],
  "improvements": ["specific, actionable improvement"],
  "customer_sentiment": "positive | neutral | negative | unclear",
  "summary": "2-3 sentence summary of what happened in this call",
  "next_action": "specific recommended next step for this lead"
}

Evaluate against these pitch elements:
- Proper greeting & rapport building
- Understanding customer needs (discovery questions)
- Product / service introduction
- Key features & benefits explained
- Pricing or budget discussion
- Handling objections
- Social proof or testimonials mentioned
- Clear call-to-action or next steps agreed`;

  const result = await callGroq(
    [{ role: 'user', content: prompt }],
    { json: true, temperature: 0.3, maxTokens: 1000 }
  );

  try {
    return JSON.parse(result.content);
  } catch {
    throw new Error('Could not parse analysis response');
  }
};

/**
 * Synthesize a sales playbook from a batch of already-analyzed call summaries,
 * split by outcome (won vs lost lead). Operates on compact per-call analysis
 * objects (not raw transcripts) to keep this cheap regardless of call volume.
 */
const generatePlaybook = async ({ wonSummaries, lostSummaries }) => {
  const fmt = (list) => list.map((c, i) => `${i + 1}. Score: ${c.overall_score ?? '?'}/10 | Sentiment: ${c.customer_sentiment || 'unknown'}
   Summary: ${c.summary || '—'}
   Covered: ${(c.pitch_covered || []).join('; ') || '—'}
   Missed: ${(c.pitch_missed || []).join('; ') || '—'}`).join('\n');

  const prompt = `You are an expert sales coach analyzing a batch of past sales call summaries to build a playbook for both an AI calling agent and a human sales team.

Calls from leads that WERE WON (converted):
"""
${fmt(wonSummaries) || 'None available.'}
"""

Calls from leads that WERE LOST:
"""
${fmt(lostSummaries) || 'None available.'}
"""

Compare the two groups and identify what separates a won call from a lost one. Respond ONLY with valid JSON:
{
  "best_practices": ["specific, actionable practice that shows up in won calls"],
  "common_objections": [{ "objection": "objection seen in lost calls", "recommended_response": "how to handle it, based on what worked in won calls" }],
  "phrases_that_work": ["short phrase or technique correlated with won calls"],
  "phrases_to_avoid": ["pattern correlated with lost calls"]
}`;

  const result = await callGroq(
    [{ role: 'user', content: prompt }],
    { json: true, temperature: 0.3, maxTokens: 1200 }
  );

  try {
    return JSON.parse(result.content);
  } catch {
    throw new Error('Could not parse playbook response');
  }
};

/**
 * Draft a complete WhatsApp message template (name, body with {{n}} variables,
 * example values, optional header text / footer / buttons) from a short brief.
 * Output is sanitized to Meta's template limits; the caller still shows it to
 * the user for review before anything is submitted for approval.
 */
const generateTemplateDraft = async ({ brief, category, language, businessName, businessDescription }) => {
  const prompt = `You write WhatsApp Business message templates that Meta approves.

Business: ${businessName || 'a business'}. ${businessDescription || ''}
Goal of the template: ${brief}
Category: ${category} (MARKETING = promotions/offers, UTILITY = updates about something the customer already did, AUTHENTICATION = OTP only)
Language: ${language} (if Hindi/Hinglish, write the message in that language)

Rules:
- body_text max 1024 characters, warm and concise, light emojis only if it fits.
- Use {{1}}, {{2}}... for personalization (first variable is normally the customer's name). Never start or end the body with a variable, and never place two variables next to each other.
- examples: one realistic sample value per variable, in order.
- name: lowercase letters, numbers and underscores only, max 40 characters.
- footer_text: optional, max 60 characters (for example "Reply STOP to opt out" for marketing).
- buttons: optional, at most 3. QUICK_REPLY buttons have text (max 25 characters). A URL button has text (max 25 characters) and a full https url. Only include a URL button if the brief gives a link.
- No misleading claims, no ALL CAPS shouting, no prohibited content.
- image_idea: one sentence describing a fitting header image scene (or empty string).
- image_headline: 2-4 words for the banner headline (or empty). image_subline: up to 6 words, e.g. the offer (or empty). image_cta: 2 words such as "Book Now" (or empty).

Respond ONLY with valid JSON:
{"name":"","category":"${category}","header_text":"","body_text":"","examples":[],"footer_text":"","buttons":[{"type":"QUICK_REPLY","text":""}],"image_idea":"","image_headline":"","image_subline":"","image_cta":""}`;

  const result = await callGroq([{ role: 'user', content: prompt }], { json: true, temperature: 0.6, maxTokens: 900 });
  let draft;
  try { draft = JSON.parse(result.content); } catch { throw new Error('AI returned an unusable draft. Please try again.'); }

  const body = String(draft.body_text || '').trim().slice(0, 1024);
  if (!body) throw new Error('AI returned an empty draft. Please try again.');
  const varCount = new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1])).size;
  const examples = Array.isArray(draft.examples) ? draft.examples.map(x => String(x).trim()) : [];
  while (examples.length < varCount) examples.push('');

  const buttons = (Array.isArray(draft.buttons) ? draft.buttons : []).slice(0, 3).map(b => {
    const text = String(b.text || '').trim().slice(0, 25);
    if (!text) return null;
    if (b.type === 'URL' && /^https:\/\//.test(b.url || '')) return { type: 'URL', text, url: b.url };
    return { type: 'QUICK_REPLY', text };
  }).filter(Boolean);

  return {
    name: String(draft.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40),
    category,
    body_text: body,
    examples: examples.slice(0, varCount),
    footer_text: String(draft.footer_text || '').trim().slice(0, 60),
    buttons,
    image_idea: String(draft.image_idea || '').trim(),
    image_headline: String(draft.image_headline || '').trim().slice(0, 40),
    image_subline: String(draft.image_subline || '').trim().slice(0, 60),
    image_cta: String(draft.image_cta || '').trim().slice(0, 25),
  };
};

// Drafts the AI Auto-Reply knowledge base (the same fields WhatsApp Hub's
// AI Auto-Reply tab saves) from a business's website content plus a few setup
// answers — so a tenant can get a working AI agent without typing everything
// in by hand. The draft is returned for review, never saved directly.
const generateAiAgentKnowledge = async ({ businessName, businessType, groundRules, businessContext, agentName, greeting, websiteText }) => {
  const prompt = `You set up a WhatsApp AI sales assistant for a business by drafting its training data from the business's own website.

Business name: ${businessName || 'the business'}
Business type: ${businessType || 'not specified'}
Extra context from the owner: ${businessContext || 'none given'}
Rules the owner wants the AI to follow: ${groundRules || 'none given'}
Agent's name (sign-off): ${agentName || 'not specified'}
Preferred opening greeting: ${greeting || 'not specified'}

Website content (may be messy/incomplete — use only what's real, never invent prices or facts not present here or in the context above):
"""
${websiteText.slice(0, 6000)}
"""

Draft the following fields for the AI's knowledge base. Every fact (prices, services, hours) must come from the website content or the owner's context above — if something isn't there, leave it out rather than guessing.
- about: 2-4 sentences on what the business does, where, for whom.
- services_prices: one per line, "Service — price" where a price is actually stated; otherwise just list the service.
- faqs: 4-8 Q&A pairs a customer would realistically ask, answerable from the given content.
- tone: how the AI should sound (warm/professional/casual), and mention it should sign off as "${agentName || 'the assistant'}" if a name was given, and open new chats with something close to the given greeting if one was given.
- goal: the single main outcome the AI should push toward (e.g. book a visit, get contact details, close a sale).
- never_say: things the AI must never claim or promise — always include "never quote a price not listed above" and anything from the owner's rules.
- handoff_rules: situations where the AI should stop and hand off to a human (e.g. complaints, price negotiation, ready to pay).

Respond ONLY with valid JSON:
{"about":"","services_prices":"","faqs":"","tone":"","goal":"","never_say":"","handoff_rules":""}`;

  const result = await callGroq([{ role: 'user', content: prompt }], { json: true, temperature: 0.4, maxTokens: 1400, reasoningEffort: 'medium' });
  let draft;
  try { draft = JSON.parse(result.content); } catch { throw new Error('AI returned an unusable draft. Please try again.'); }

  const fields = ['about', 'services_prices', 'faqs', 'tone', 'goal', 'never_say', 'handoff_rules'];
  const cleaned = {};
  for (const f of fields) cleaned[f] = String(draft[f] || '').trim().slice(0, 4000);
  if (!cleaned.about) throw new Error('AI could not draft anything usable from that website. Try adding more detail in the business context field.');
  return cleaned;
};

module.exports = { callGroq, generateTemplateDraft, qualifyLead, generateFollowUpMessage, summarizeLead, analyzeMarket, transcribeAudio, analyzeRecording, generatePlaybook, generateAiAgentKnowledge };
