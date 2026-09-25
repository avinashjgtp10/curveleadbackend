# CurveLead V2 — Lead Management Backend

A multi-tenant SaaS backend for lead management built with Node.js + Express + PostgreSQL.

## Features

- 🎯 **Lead Management** — Pipeline, scoring, follow-ups, journey tracking
- 📊 **Campaigns** — Track ad spend, calculate CPL & ROI
- 💬 **WhatsApp Inbox** — Shared team inbox with conversation history
- 🤖 **AI Scoring** — Auto-classify leads as hot/warm/cold via Groq API
- 🤖 **AI Qualification Bot** — Auto-qualify leads on WhatsApp
- 📈 **Conversion Reports** — By source, stage, staff, campaign
- 🔐 **Multi-tenant** — Complete data isolation per business
- 🔌 **Meta Ads Integration** — Auto-capture leads from Facebook/Instagram

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express 4
- **Database:** PostgreSQL (AWS RDS)
- **Auth:** JWT
- **AI:** Groq API (Llama 3.1)
- **WhatsApp:** WhatsApp Business Cloud API
- **Email:** Nodemailer (Gmail SMTP)

## Setup

### 1. Clone & Install

```bash
git clone https://github.com/avinashjgtp10/curveleadbackend.git
cd curveleadbackend
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
nano .env
```

Required vars:
- `DB_HOST`, `DB_PASSWORD` — PostgreSQL connection
- `JWT_SECRET` — Random 64-char string
- `GROQ_API_KEY` — Get from https://console.groq.com (free)
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` — WhatsApp Business API
- `EMAIL_USER`, `EMAIL_APP_PASSWORD` — Gmail App Password

### 3. Setup Database

**Fresh install:**
```bash
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/schema.sql
```

**Migration from V1:**
```bash
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_v2.sql
```

### 4. Run

**Development:**
```bash
npm run dev
```

**Production (PM2):**
```bash
pm2 start ecosystem.config.js
pm2 save
```

## API Endpoints

### Auth
- `POST /api/auth/signup` — Create account
- `POST /api/auth/login` — Login
- `GET /api/auth/me` — Current user
- `POST /api/auth/forgot-password` — Send reset link
- `POST /api/auth/reset-password` — Reset password

### Leads
- `GET /api/leads` — List leads (filters: stage, source, score, campaign)
- `POST /api/leads` — Create lead
- `GET /api/leads/:id` — Get lead with timeline
- `PUT /api/leads/:id` — Update lead
- `DELETE /api/leads/:id` — Delete lead
- `POST /api/leads/:id/score` — AI score this lead

### Campaigns
- `GET /api/campaigns` — List campaigns with ROI
- `POST /api/campaigns` — Create campaign
- `PUT /api/campaigns/:id` — Update campaign
- `GET /api/campaigns/:id/leads` — Leads from this campaign
- `GET /api/campaigns/:id/roi` — ROI calculation

### WhatsApp
- `GET /api/whatsapp/inbox` — Recent conversations
- `GET /api/whatsapp/conversations/:leadId` — Message history
- `POST /api/whatsapp/send` — Send message to lead

### AI
- `POST /api/ai/score-lead/:leadId` — Score a single lead
- `POST /api/ai/score-bulk` — Score all unscored leads
- `POST /api/ai/qualify/:leadId` — Run qualification bot

### Reports
- `GET /api/reports/conversion` — Conversion funnel
- `GET /api/reports/by-source` — Leads by source
- `GET /api/reports/by-staff` — Performance by staff
- `GET /api/reports/by-campaign` — Campaign ROI report

## Deployment

CI/CD via GitHub Actions. Push to `master` → auto-deploys to EC2.

Required GitHub secrets:
- `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`

### Deployed-Environment Configuration (AWS SSM Parameter Store)

`bootstrap.js` — not `server.js` — is the process entry point. `NODE_ENV`
decides where config comes from:

- **Unset, or `development`**: plain local machine, no AWS involved — falls
  back to `.env` exactly like before (`npm run dev` never touches SSM).
- **Any other value** (`dev`, `production`, `staging`, ...): treated as a real
  deployed environment. `bootstrap.js` loads every parameter under
  `/curvelead/backend/<NODE_ENV>/` from AWS SSM Parameter Store into
  `process.env` — before the Express app, DB pool, or any other service is
  required — then hands off to `server.js`.

- Each deployed environment's EC2 instance needs its own IAM role (instance
  profile) using `docs/ssm-iam-policy.json` with `<ENV>` replaced by that
  environment's name — e.g. a `dev` box's role is scoped to only
  `/curvelead/backend/dev/*`, a `production` box's role only to
  `/curvelead/backend/production/*`. No AWS keys are ever stored in code,
  `.env`, or on any instance.
- `AWS_REGION` (default `us-east-1`, matching where RDS/EC2 already run) and
  `NODE_ENV` are set directly in that environment's PM2 `env` block, never in
  Parameter Store — SSM can't supply the region or environment name needed to
  reach SSM in the first place (same chicken-and-egg problem for both).
- Redis is not used by this app; there is nothing to configure there.
- If a required parameter is missing, the process logs the missing *names*
  (never values) and exits non-zero rather than starting half-configured.

Create a parameter (example: the `dev` environment):
```bash
aws ssm put-parameter --name "/curvelead/backend/dev/DB_PASSWORD" \
  --value "..." --type "SecureString" --region us-east-1
```

Required parameters (String unless noted):
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (SecureString)
- `JWT_SECRET` (SecureString)
- `META_APP_ID`, `META_APP_SECRET` (SecureString), `META_WEBHOOK_VERIFY_TOKEN` (SecureString)
- `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (SecureString), `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (SecureString)
- `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, `RESEND_API_KEY` (SecureString)
- `S3_BUCKET_NAME`
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (SecureString)
- `FRONTEND_URL`

Optional (has a code-level default if unset): `JWT_EXPIRES_IN`, `GROQ_API_KEY`
(SecureString), `GROQ_MODEL`, `API_URL`, `API_BASE_URL`, `PORT`,
`CORS_ALLOWED_ORIGINS` (defaults to localhost + curvelead.com), `IDEOGRAM_API_KEY`
(SecureString — AI template header image generation stays off until this is set).

Never stored anywhere (IAM role only): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

Applying a config change to a running instance for the first time (or after
changing `script`/`env` in `ecosystem.config.js`) needs one manual refresh,
since `pm2 restart --update-env` doesn't re-read a changed script path:
```bash
pm2 delete curvelead-api
pm2 start ecosystem.config.js
pm2 save
```
After that, the existing `pm2 restart curvelead-api --update-env` (used by the
GitHub Actions deploy) picks up parameter changes on every restart.

## License

Proprietary — © 2026 CurveLead
