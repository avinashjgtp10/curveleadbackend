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
