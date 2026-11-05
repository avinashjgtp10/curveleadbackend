# CurveLead Voice (human-agent calling) — setup & rollout

Web only for now; mobile is handled separately. Everything is **fail-closed**: no country can be dialled until a
platform admin enables the route, the organization lists the country, a verified caller ID and a rate exist, and the wallet has funds.

## 1. Deploy
1. Run `models/migration_voice_calling.sql` on RDS (idempotent; seeds 9 country policies, all **disabled**).
2. Add parameters to AWS Parameter Store (`bootstrap.js` loads everything under `/curvelead/backend/<env>/` into `process.env`
   at boot, so restart the process after adding them). Replace `<env>` with `dev` or `production`:
   ```bash
   aws ssm put-parameter --name "/curvelead/backend/<env>/VOICE_TELNYX_API_KEY"    --type SecureString --value "<telnyx api key>"
   aws ssm put-parameter --name "/curvelead/backend/<env>/VOICE_TELNYX_PUBLIC_KEY" --type SecureString --value "<base64 Ed25519 public key from Mission Control>"
   aws ssm put-parameter --name "/curvelead/backend/<env>/VOICE_DEFAULT_PROVIDER"  --type String --value "telnyx"
   ```
   At boot the API validates the two secrets (`services/voiceCalling/config.js`): the API key must start with `KEY`, the public key must be
   base64 of a raw 32-byte Ed25519 key. If either is missing or malformed it logs `[voice] ...` errors and voice stays disabled
   (`GET /api/voice/status` -> `enabled:false`; token/authorize/call return 503 `VOICE_UNAVAILABLE`); the API still starts.
   Only the two secrets are required. `VOICE_AUTH_TTL_SECONDS`, `VOICE_RESERVE_CAP_SECONDS`, `VOICE_VELOCITY_MAX_5MIN`,
   `VOICE_CALL_RATE_LIMIT_PER_MIN`, `VOICE_TOPUP_MIN_MINOR`, `VOICE_TOPUP_MAX_MINOR` are optional (defaults in `.env.example`).
   Do not add them to `REQUIRED_VARS`: calling is optional, so a missing key must not stop the whole API from starting.
   Razorpay vars already exist. Also make sure `API_BASE_URL` is set (it builds the webhook URL).
3. Razorpay dashboard: add `payment.captured` (and/or `order.paid`) to the existing webhook's events. Wallet credit needs it as a
   backstop if the browser closes after paying.
4. Telnyx: create a Credential Connection for WebRTC; set its webhook URL to `https://<api>/api/voice/webhooks/telnyx`.

## 2. Onboard an organization (Super Admin → Calling)
1. Pick the organization → set Telnyx connection ID, currency, approved destination countries → Save (status stays `pending`).
2. Add + **Verify** a caller ID the organization is entitled to present.
3. Add a rate (provider cost + markup) for each destination prefix.
4. Enable the platform route (origin → destination) with an approval note recording the provider + legal verification.
5. Set account status `active` and business verification `verified`. Organization admin recharges the wallet from Calling → Wallet.

## 3. Must be verified on a real account before rollout (not verifiable offline)
- A browser-placed call's webhooks carry `client_state` and `to` (call correlation and the dialled-number check depend on it).
- `call.hangup` `hangup_cause` values used for no-answer/busy classification.
- Client tokens minted via API last 24h and are not individually revocable (revoke by deleting the agent's credential).
- Provider-cost reconciliation against Telnyx detail records (not implemented).

## Configuration reference (everything the voice module reads)

Environment / Parameter Store (`/curvelead/backend/<env>/NAME`):

| Name | Secret? | Needed? | Default / notes |
|---|---|---|---|
| `VOICE_TELNYX_API_KEY` | **Yes** (SecureString) | Yes, to enable | Telnyx v2 key, must start with `KEY` |
| `VOICE_TELNYX_PUBLIC_KEY` | No (it is a *public* key; keep out of git anyway) | Yes, to enable | base64 of the raw 32-byte Ed25519 key |
| `VOICE_DEFAULT_PROVIDER` | No | No | `telnyx` (only implemented provider) |
| `VOICE_ALLOWED_DESTINATIONS` | No | No | `IN,SG,AE`. Hard platform allow-list; can only narrow, never add countries beyond IN/SG/AE |
| `VOICE_AUTH_TTL_SECONDS` | No | No | `60` |
| `VOICE_RESERVE_CAP_SECONDS` | No | No | `900` (wallet hold per call) |
| `VOICE_VELOCITY_MAX_5MIN` | No | No | `20` calls per agent per 5 min |
| `VOICE_CALL_RATE_LIMIT_PER_MIN` | No | No | `30` per user |
| `VOICE_TOPUP_MIN_MINOR` / `VOICE_TOPUP_MAX_MINOR` | No | No | `10000` / `10000000` (minor units) |
| `API_BASE_URL` | No | Only for server-dial mode | Browser calling uses the webhook URL set on the Telnyx connection |

Stored in the database (Super Admin → Calling), not in env:

| Value | Where | Example |
|---|---|---|
| Telnyx connection ID | account → "Telnyx connection ID" | `3086510505527870746` |
| Caller ID | Caller IDs (add, then Verify) | `+15673603199` |
| Outbound Voice Profile | Telnyx portal only; the code never references it | `3086508125579118435` |

Note `VOICE_WEBHOOK_REQUIRE_SIGNATURE` belongs to the separate AI-calling (Vapi) module, not to CurveLead Voice.

## Hard platform rules (enforced in code, independent of database rows)
- Destinations: only +91 (IN), +65 (SG), +971 (AE) numbers can be dialled. Anything else is denied as `ROUTE_DISABLED`.
- Calling hours are evaluated in the **lead's** zone: IN `Asia/Kolkata`, SG `Asia/Singapore`, AE `Asia/Dubai`.
  A policy row may narrow a window but never widen it. UAE ceiling: 09:00-18:00. IN and SG windows come from the
  policy rows (placeholder 09:00-21:00; confirm the legal window with counsel before enabling those routes).
- Caller ID: chosen per call from `voice_phone_numbers` — the agent's assigned number, else a number whose country
  matches the destination, else any verified org number. Add an India number later and it takes over for +91 with no API change.
- Run `models/migration_voice_uae_hours.sql` to align stored UAE policy rows with the 09:00-18:00 ceiling.
