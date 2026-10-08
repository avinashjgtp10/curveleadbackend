// Canonical grouping of every `notifications.type` value the app actually creates,
// into the handful of toggles a user sees in Notification Settings. Keeping this
// as the single source of truth — createNotification() reads it to decide whether
// to skip creating a notification, and the frontend mirrors the same groups/labels.
const NOTIFICATION_GROUPS = [
  {
    key: 'new_leads',
    label: 'New leads',
    description: 'A new lead came in from any source.',
    types: ['new_lead'],
  },
  {
    key: 'new_messages',
    label: 'New WhatsApp messages',
    description: 'A lead sends you a new WhatsApp message.',
    types: ['whatsapp'],
  },
  {
    key: 'assigned_to_me',
    label: 'Leads assigned to me',
    description: 'A lead is assigned or reassigned to you.',
    types: ['assignment', 'sla_reassigned', 'sla_reassigned_away'],
  },
  {
    key: 'sla_alerts',
    label: 'Uncontacted lead alerts',
    description: 'A lead has gone too long without a first response.',
    types: ['sla_risk', 'sla_escalated', 'sla_missed'],
  },
  {
    key: 'followups',
    label: 'Follow-up & demo reminders',
    description: 'A follow-up or demo is due soon, overdue, or was never scheduled.',
    types: ['followup_due', 'demo_due', 'no_followup_scheduled', 'escalation'],
  },
  {
    key: 'ai_handoff',
    label: 'AI handoff needed',
    description: 'The AI auto-reply needs a human to take over a conversation.',
    types: ['ai_handoff'],
  },
  {
    key: 'hot_leads',
    label: 'Hot lead escalation',
    description: 'A hot lead or priority-campaign lead needs personal attention.',
    types: ['lead_escalation'],
  },
  {
    key: 'social_posts',
    label: 'Social post problems',
    description: 'A scheduled Facebook, Instagram or Google post could not be published.',
    types: ['social_post_failed'],
  },
];

const FOLLOWUP_GROUP_KEY = 'followups';
const FOLLOWUP_TYPES = new Set(NOTIFICATION_GROUPS.find(g => g.key === FOLLOWUP_GROUP_KEY).types);

const TYPE_TO_GROUP = new Map(
  NOTIFICATION_GROUPS.flatMap(g => g.types.map(t => [t, g.key]))
);

// A type with no group is a bug (a new createNotification call was added without
// updating NOTIFICATION_GROUPS above) — default it to enabled rather than silently
// dropping notifications the user never had a chance to opt out of.
const isNotificationEnabled = (userSettings, type) => {
  const groupKey = TYPE_TO_GROUP.get(type);
  if (!groupKey) return true;
  return userSettings?.notification_prefs?.[groupKey] !== false;
};

// A follow-up/demo/escalation notification about a lead that's already marked
// Lost is just noise — the deal is dead, nothing to follow up on. Defaults to
// skipping them (skip_lost_lead_followups !== false), separate from the main
// on/off toggle for the group so it can be turned back on independently.
const shouldSkipForLostLead = (userSettings, type) => {
  if (!FOLLOWUP_TYPES.has(type)) return false;
  return userSettings?.notification_prefs?.skip_lost_lead_followups !== false;
};

module.exports = { NOTIFICATION_GROUPS, isNotificationEnabled, shouldSkipForLostLead };
