# Automation v5: delivery reliability and enquiry routing

This change adds configuration and reliability infrastructure. The migration does
not create or activate any sequences/rules, enrol leads, or send messages.

## Migration

Stop the local backend/sequence workers before applying the migration. Apply the
existing automation schema and v2/v3/v4 migrations first, plus the existing lead,
WhatsApp, consent, AI-pause, pipeline and follow-up migrations. Then apply:

```bash
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f models/migration_lead_automation_v5.sql
```

Select a local database explicitly; do not load production credentials for local
validation. The migration is transactional and rerunnable. Deploying this code
without the migration is not supported. Restart the local backend after it succeeds.

Existing sequence configuration retains stop-on-reply and does not gain automatic
demo/customer stops unless configured. Existing enrolments are not retroactively
changed or sent during migration. Terminal records stay terminal. Product-specific
new-lead rules take precedence over generic campaign/escalation rules; when no
product-specific rule matches, existing precedence is preserved.

## Exact Salonox setup (save as drafts; do not enrol leads during preparation)

1. Confirm the approved WhatsApp template `salonox_new_enquiry_welcome`, its actual
   language code, and its body text. The engine does not create or approve templates.
   The text should ask for 1: Starting a new business; 2: Managing manually;
   3: Using another software. Marketing templates still require recorded opt-in.
2. In **Lead Automation > Automation Settings**, create the branch sequences:
   **New Business**, **Manual Management**, **Using Other Software**. Configure each
   branch's actual messages/templates. Leave **Active** unchecked. Select stops for
   demo booked and customer converted; opt-out always applies.
3. Create **Salonox – New Software Enquiry**, also inactive. Configure demo/customer
   stops. Add four WhatsApp steps with delays after the previous step:

   | Step | Delay | Template configuration |
   | --- | --- | --- |
   | Welcome | 0 minutes | Always send approved template; `salonox_new_enquiry_welcome`; exact language; body parameter 1 = name |
   | Follow-up 1 | 1 day | Choose the appropriate approved follow-up template |
   | Follow-up 2 | 2 days | Choose the appropriate approved follow-up template |
   | Follow-up 3 | 3 days | Choose the appropriate approved follow-up template |

   Choose Always-template for follow-ups if templates must be used in all cases.
   Otherwise provide message text with `{{name}}` and an approved fallback template.
4. On the welcome step, add reply routes:

   | Answer | Classification/label | Target sequence | Example exact aliases (one per line) |
   | --- | --- | --- | --- |
   | 1 | New Business | New Business | Starting a new business; I am starting a new business |
   | 2 | Manual Management | Manual Management | Managing manually; I manage manually |
   | 3 | Using Other Software | Using Other Software | Already using another software; I use another software |

   The semicolons above separate aliases; enter each alias on its own line in the UI.
   Answers are case-insensitive, whitespace-normalized exact matches, with trailing
   sentence punctuation ignored. `1` does not match `10`. Unlisted or conflicting
   replies enter human review; the engine does not guess semantic meaning.
5. Create an inactive rule: **When: A new lead is received**; **Product interest:
   Salonox**; target **Salonox – New Software Enquiry**. This filters `leads.product`
   using trimmed, case-insensitive equality. Ensure each ingest source actually
   populates this field. Manual creation/editing exposes it; Meta field keys
   `product`, `product_interest`, `product_interested_in` are mapped. Other custom
   Meta questions need an explicit mapping upstream. Editing product later does
   not replay the new-lead trigger; use explicit manual enrolment if intended.
6. Keep the rule and all sequences inactive until a separate, authorized activation.
   Branch targets must be active at runtime. Never enrol live leads as a setup test.

Zero delay means the next worker poll (currently five minutes), not synchronous
sending in the lead-creation request. Business hours and daily caps can shift the
schedule; nominal steps are day 0, day 1, day 3, day 6.

## Delivery and recovery

- A worker claims due enrolments with PostgreSQL row locking and SKIP LOCKED.
  Each enrolment/step has one durable send-attempt record.
- Immediately before provider I/O the worker locks the lead and enrolment and
  checks cancellation, pause, opt-out, stop conditions and sequence activation.
  Existing appointment/stage writes serialize with these locks.
- Missing/unapproved/invalid templates or parameters block the step. Missing
  consent/credentials also block. Sending failures never advance the step.
- Explicit rate-limit rejection is retried with bounded backoff, up to four
  attempts. Generic network/timeout/server uncertainty is not blindly retried.
  A durable send-intent marker survives post-send transaction failure and causes
  conservative reconciliation on the next claim.
- **Automation Leads > View Details** and the lead's Automation tab show reasons
  and recovery controls. Fix a blocked/failed step, then retry it. Manual pause is
  preserved by recovery. Resume through the WhatsApp inbox only when appropriate.
- For uncertain outcomes, check provider records, enter a reconciliation note,
  and either confirm sent with a provider message ID or explicitly confirm not
  sent before requesting another attempt. Operator actions are logged.
- Ambiguous answers pause automation. Review the chat, resume deliberately, then
  use **Apply reviewed route**. Routing and the label/branch write are atomic.
- Question routing begins only after confirmed submission of that question step.
  Already-processed webhooks cannot create duplicate branches. Pending routes are
  snapshotted, so later sequence editing does not silently change an asked question.
- Sequences without question routes retain configurable legacy stop-on-reply.
  A routed reply cancels the common sequence without cancelling the newly created
  branch. Enrolment uniqueness remains lifetime tenant + lead + sequence.

## Stop event coverage and limitations

The migration hooks existing `lead_followups` inserts/updates for open
`followup_type = 'demo'` bookings. This covers current manual and AI booking paths.
It hooks lead stage/won/opt-out updates for conversion and opt-out cancellation.
Visits/consultations are not treated as demos. There is no invented external
calendar integration; an external booking must reach the existing appointment
API/table for this stop to occur. The final worker check also catches existing
bookings/conversions when an enrolment starts later.

A provider request already submitted cannot be recalled. No provider-level
exactly-once guarantee is claimed: unknown outcomes require operator reconciliation.
There is one question-routing step per sequence; multiple simultaneous pending
questions require human review. Named template variables, dynamic buttons and
variable text headers are blocked; numeric body parameters and configured media
headers are supported. Template catalogues are briefly cached by the shared
service; stale fallback catalogues are rejected by the sequence worker.

The send transaction holds lead/enrolment locks during provider I/O (30-second
HTTP timeout); concurrent writes to that lead may wait. Recovery does not
retroactively route replies received before a question's delivery was confirmed.

## Local tests

The integration suite only accepts an explicitly provided loopback URL whose
DB name starts with `curvelead_test_`. It creates/drops an isolated schema and
uses mocked provider calls; it does not start the application or read `.env`.

```bash
AUTOMATION_TEST_DATABASE_URL="$LOCAL_TEST_DATABASE_URL" node --test tests/automationV5.test.js
node --test tests/batch1WhatsappSafety.test.js tests/batch1Locale.test.js tests/phase4.test.js tests/adsPhase2.test.js
```

Without the explicit test URL, pure policy tests run and database tests are skipped.
From frontend: `node --test tests/automationBuilder.test.js` and `npm run build`.
