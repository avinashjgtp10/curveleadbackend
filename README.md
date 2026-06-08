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

## License

Proprietary — © 2026 CurveLead
