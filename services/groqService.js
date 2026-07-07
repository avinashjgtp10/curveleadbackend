const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

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

  const prompt = `You are a friendly sales assistant for ${businessContext.business_name || 'our business'}.

Business context: ${businessContext.description || 'We help businesses with their needs.'}

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

module.exports = { callGroq, qualifyLead, summarizeLead, analyzeMarket, transcribeAudio, analyzeRecording, generatePlaybook };
