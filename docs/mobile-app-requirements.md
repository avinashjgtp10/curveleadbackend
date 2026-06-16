# CurveLead Mobile App — Build Brief (v1 / Full Feature Parity)

> Paste this whole document to Claude (or any AI/dev) as the brief for building the mobile app.
> It targets the **existing CurveLead backend** in this repo — no backend changes are required for v1 except where noted in §8. The app is a pure REST API client.

---

## 1. What CurveLead Is

CurveLead is a **multi-tenant lead-management / mini-CRM SaaS**. Each business ("tenant") signs up, gets a subscription plan with limits (max leads, max users), and its staff manage leads through a pipeline of stages, with notes, follow-ups, WhatsApp conversations, campaigns, AI scoring, quotations, brochures, call recordings, and reporting. Billing runs through Razorpay; a separate super-admin role manages the whole platform across tenants.

The mobile app is a **full-parity companion client** for this same backend — same accounts, same data, same capabilities as the web dashboard.

## 2. Tech Stack (decided)

- **Framework:** React Native with **Expo** (managed workflow).
- **Language:** TypeScript.
- **Navigation:** `expo-router` (file-based routing), with role-based route groups.
- **State/data fetching:** TanStack Query (React Query) for server state + caching; Zustand for auth/session state.
- **Forms:** `react-hook-form` + `zod`.
- **Storage:** `expo-secure-store` for JWT; `AsyncStorage` for non-sensitive cache.
- **Push notifications:** `expo-notifications`.
- **File handling:** `expo-document-picker` / `expo-image-picker` for brochures, attachments, recordings upload; `expo-av` for audio/video playback.
- **In-app payments:** Razorpay's React Native SDK (`react-native-razorpay`) for plan upgrade checkout, since the backend already issues Razorpay orders.
- **Build/distribution:** EAS Build + EAS Submit (TestFlight / Play internal testing).
- **Target platforms:** iOS + Android from one codebase.

## 3. Users & Roles (single app, role-based UI)

| Role | Mobile access |
|---|---|
| `staff` | Own leads, followups, notes, attachments, recordings, WhatsApp inbox, quotations/brochures they create, notifications, personal dashboard |
| `admin` | Everything staff sees + all tenant leads, full staff management, campaigns, integrations settings, billing/invoices, lead-stage & template management, tenant-wide reports |
| `super_admin` | Everything admin sees **plus** a Super Admin section: platform stats, tenant list/management, trial extension, plan management |

Role comes from `GET /api/auth/me` / login response (`user.role`). Gate screens/components with a `usePermission(role)` helper — one codebase, conditional navigation tabs/menu items per role.

## 4. Full Feature Scope for v1

1. **Auth** — login, signup, forgot/reset password, change password, persisted session, logout.
2. **Leads** — list (search/filter/paginate/sort by stage), detail, create, edit, delete (admin), bulk update stage, bulk delete (admin), CSV/Excel import + template download, lead-source ingestion view.
3. **Lead notes** — full CRUD per lead.
4. **Followups** — today's followups, create, complete, delete, full list/calendar.
5. **Lead stages** — read for pipeline/kanban view; admin CRUD.
6. **Staff management (admin)** — list, invite, edit, delete team members; plan-limit aware.
7. **Campaigns (admin/staff create)** — list, detail, create, edit, delete (admin), per-campaign stats.
8. **WhatsApp** — inbox (conversations list), per-lead conversation thread, send message.
9. **AI features** — score a lead, bulk score leads, summarize a lead, run market analysis, qualify test.
10. **Integrations (admin)** — view/update lead-source settings, generate/revoke API key, view embed script, Facebook OAuth connect + page connect + lead sync.
11. **Quotations** — list, detail, create, edit, send to lead, accept/reject status, delete; public read-only view link (share-able, no auth) reused from web.
12. **Brochures (admin upload, all roles view/share)** — list, upload (PDF/image), delete, share with a lead.
13. **Message templates** — list, create, edit, delete, generate/send from template.
14. **Call recordings** — upload audio/video against a lead, list per-lead, team-wide list (admin), delete, retry AI analysis.
15. **Attachments** — upload/list/delete per lead, share an attachment via WhatsApp.
16. **Notifications** — list, unread badge, mark one/all read; push notifications for new lead assigned, followup due, WhatsApp message received.
17. **Reports/Dashboard** — summary cards, conversion report, by-source, by-staff, by-campaign, timeline (charts).
18. **Billing (admin)** — view current subscription, plan list, view invoices, create Razorpay order + verify payment for plan upgrade.
19. **Settings (admin)** — tenant settings (business info, etc.), lead-stage management (shared with #5).
20. **Super Admin section (super_admin only)** — platform stats, tenant list, update tenant, extend trial, plan list.

This is full parity with the web app's backend surface — nothing deferred to "Phase 2" except items explicitly called out in §8.

## 5. Backend API Contract (already implemented — confirm against code before building)

Base URL: `https://<your-api-domain>/api`. Auth via `Authorization: Bearer <JWT>` after login (native apps aren't subject to browser CORS — the allowlist in [server.js](../server.js) only matters for web).

Tenant scoping happens server-side off the JWT — never pass a tenant ID manually. Every list above is just a thin wrapper around these routes; **re-check the actual controller for exact request/response field names and query params before wiring each screen** — this table is a map, not the source of truth.

| Area | Routes | Source |
|---|---|---|
| Auth | signup, login, me, forgot/reset-password, change-password | [routes/auth.js](../routes/auth.js) |
| Leads | CRUD, bulk update/delete, import, stages, today's followups, quick note/followup | [routes/leads.js](../routes/leads.js) |
| Notes | CRUD per lead | [routes/notes.js](../routes/notes.js) |
| Followups | CRUD + complete | [routes/followups.js](../routes/followups.js) |
| Lead stages | CRUD (also mirrored under `/settings/stages`) | [routes/leadStages.js](../routes/leadStages.js), [routes/settings.js](../routes/settings.js) |
| Staff | list, create/invite, update, delete (admin) | [routes/staff.js](../routes/staff.js) |
| Campaigns | CRUD + stats | [routes/campaigns.js](../routes/campaigns.js) |
| WhatsApp | inbox, conversation, send, webhook (public) | [routes/whatsapp.js](../routes/whatsapp.js) |
| AI | score-lead, score-bulk, summarize, qualify, market-analysis | [routes/ai.js](../routes/ai.js) |
| Integrations | settings, api-key, embed-script, Facebook OAuth/connect/sync, public ingest | [routes/integrations.js](../routes/integrations.js) |
| Quotations | CRUD, send, accept, reject, public view (no auth) | [routes/quotations.js](../routes/quotations.js) |
| Brochures | list, upload, delete, share-with-lead | [routes/brochures.js](../routes/brochures.js) |
| Templates | CRUD + generate/send | [routes/templates.js](../routes/templates.js) |
| Recordings | upload, list per-lead, team list (admin), delete, retry analysis | [routes/recordings.js](../routes/recordings.js) |
| Attachments | list/upload/delete per lead, share-via-WhatsApp | [routes/attachments.js](../routes/attachments.js) |
| Notifications | list, count, mark read/read-all | [routes/notifications.js](../routes/notifications.js) |
| Reports | summary, conversion, by-source, by-staff, by-campaign, timeline | [routes/reports.js](../routes/reports.js) |
| Payments | plans, create-order, verify (admin) | [routes/payments.js](../routes/payments.js) |
| Billing | create-order, verify-payment, invoices, current subscription, webhook (public) | [routes/billing.js](../routes/billing.js) |
| Settings | tenant settings + stages (admin) | [routes/settings.js](../routes/settings.js) |
| Super Admin | platform stats, tenants list/update, extend-trial, plans | [routes/superAdmin.js](../routes/superAdmin.js) |

**Subscription gate:** `authenticate` middleware returns `402` if trial expired (bypassed only for `/api/auth` and `/api/payments`) — app must surface an upgrade prompt and route admins straight to the in-app billing/plan-upgrade screen.

**Plan limit gate:** creating leads/staff over plan limits returns `403` with a message — surface as a toast/alert, not a generic error, and deep-link to billing/upgrade if the user is admin.

**File uploads:** leads import (`csv/xls/xlsx`, 5MB), brochures (`pdf/jpg/jpeg/png/webp`, 10MB), recordings (`audio/video`, 100MB), attachments (5MB) — all `multipart/form-data` via `multer.memoryStorage()`. Use `expo-document-picker`/`expo-image-picker` + `FormData` to match.

**Public/no-auth endpoints** (usable for share links inside or outside the app): WhatsApp webhook, integrations lead ingest, quotations public view, billing/Razorpay webhook.

## 6. Non-functional Requirements

- **Offline tolerance:** cache last-fetched lists (leads, followups, notifications) via React Query persistence; queue or clearly fail writes when offline, never crash.
- **Push notifications:** register Expo push token after login and send it to the backend. **No `device_tokens` table/endpoint exists yet** — this requires a small backend addition (see §8).
- **Security:** JWT in `expo-secure-store` only; auto-logout on `401`; never log tokens/PII.
- **Performance:** virtualized lists (`FlashList`) for leads/recordings/WhatsApp inbox; lazy-load report charts; background upload progress UI for large recording files (up to 100MB).
- **Error handling:** centralized API client mapping `401/402/403/5xx` to consistent UI states.
- **Media:** in-app audio/video playback for call recordings (`expo-av`), PDF/image preview for brochures/attachments.
- **Payments:** Razorpay RN SDK checkout flow wired to `create-order` → `verify-payment`, matching the existing web flow.
- **Accessibility:** standard RN accessibility props, 44x44 minimum tap targets.
- **Theming:** match CurveLead web branding (colors/logo from `public/` assets); light mode for v1 unless told otherwise.

## 7. Screen List (v1 — full parity)

1. Splash / auth-check redirect
2. Login / Signup
3. Forgot/reset password
4. Home / Dashboard (summary cards, today's followups, quick actions)
5. Leads list (search/filter/sort/bulk actions) + import flow
6. Lead detail (info, notes, followups, attachments, recordings, quotations, WhatsApp thread — tabs)
7. Create/Edit Lead
8. Add Note / Add Followup (modals)
9. Upload Attachment / Upload Recording (with playback)
10. Pipeline / Stage view (kanban-style, admin can manage stages)
11. WhatsApp Inbox + Conversation thread
12. Campaigns list/detail/create/edit + stats
13. AI tools (score lead, bulk score, summarize, market analysis) — surfaced contextually on lead detail + a dedicated AI tab
14. Quotations list/detail/create/edit + send/accept/reject status, public-share preview
15. Brochures library (upload, share-to-lead)
16. Message templates (list/create/edit, generate/send)
17. Team / Staff management (admin: invite/edit/delete)
18. Integrations settings (admin: API key, embed script, Facebook connect/sync)
19. Reports (summary, by-source/staff/campaign, conversion, timeline charts)
20. Billing (admin: current plan, invoices, upgrade via Razorpay checkout)
21. Settings (tenant info, profile, change password, logout)
22. Super Admin section (super_admin: platform stats, tenants list, tenant detail/update, extend trial, plans)
23. Notifications list + unread badge

## 8. Backend additions required for full parity (not yet implemented)

These are the only gaps between "everything the web app can do" and what the current backend exposes:

1. **Push device token registration** — add `device_tokens` table + `POST /api/notifications/register-device` (or similar) so the backend can target Expo push notifications per user/device.
2. **Mobile-aware notification triggers** — confirm server-side events (new lead assigned, followup due, WhatsApp message received) actually fire a push, not just an in-app notification row, once device tokens exist.
3. **CORS/network config** — not actually needed for native HTTP calls, but double check any signed-URL/webhook flows (e.g. Facebook OAuth redirect, Razorpay checkout return URL) work with a mobile deep link (`curvelead://...`) instead of a browser redirect.

Everything else in §4 is already backed by an existing endpoint — flag during implementation if a controller's actual behavior diverges from this brief.

## 9. Open Questions to resolve before/while building

1. **Facebook OAuth on mobile:** the web flow is presumably a browser redirect — on mobile this needs `expo-auth-session` or an in-app browser; confirm the OAuth app's redirect URI supports a mobile callback.
2. **Razorpay checkout UX:** confirm using `react-native-razorpay` vs. an in-app WebView wrapping the existing web checkout.
3. **App branding:** app name, icon, splash, bundle identifiers (`com.curvelead.app`?), who owns the Apple/Google developer accounts.
4. **API base URL / environments:** confirm prod URL and whether a staging API exists for mobile QA.
5. **Minimum OS versions** (affects Expo SDK choice).

---

### How to use this doc with Claude

Give Claude this file plus access to this backend repo, and ask it to scaffold the Expo app, implement screens in the order in §7, and use the API contract in §5 — instructing it to **always double-check each endpoint's actual request/response shape in the corresponding controller file before wiring a screen**, and to flag anything in §8 as backend work, not mobile work.
