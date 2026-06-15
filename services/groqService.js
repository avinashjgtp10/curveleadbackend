const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.1-70b-versatile';

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
 * Score a lead as hot/warm/cold based on data
 */
const scoreLead = async (leadData) => {
  const prompt = `You are a sales lead scoring expert. Score this lead as "hot", "warm", or "cold" based on signals.

Lead Information:
- Name: ${leadData.name}
- Phone: ${leadData.phone}
- Email: ${leadData.email || 'not provided'}
- Source: ${leadData.source}
- Stage: ${leadData.stage}
- Deal value: ₹${leadData.deal_value || 0}
- Days since created: ${Math.floor((Date.now() - new Date(leadData.created_at)) / (1000 * 60 * 60 * 24))}
- Notes: ${leadData.notes || 'none'}
- Recent activity: ${leadData.recent_activity || 'none'}

Scoring rules:
- "hot": High-intent signals (asked for demo, mentioned budget, urgent timeline, replied multiple times, high deal value)
- "warm": Engaged but exploring (responded to messages, showed interest, asked questions)
- "cold": No engagement or negative signals (no response, said "not interested", old lead with no activity)

Respond ONLY with valid JSON:
{
  "score": "hot|warm|cold",
  "reason": "brief 1-line explanation",
  "confidence": 0.0-1.0
}`;

  const result = await callGroq(
    [{ role: 'user', content: prompt }],
    { json: true, temperature: 0.3 }
  );

  try {
    return JSON.parse(result.content);
  } catch (e) {
    return { score: 'warm', reason: 'AI response parsing failed', confidence: 0.5 };
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

module.exports = { callGroq, scoreLead, qualifyLead, summarizeLead, analyzeMarket };
