# Ads & Social — Phase 6: social posting and scheduling

Plan: `PLAN.md` §9. Nothing here has been run against production.

## What changed

- **Social page** (Grow → Social, admins): write one post and publish it now, schedule it, or save a draft for any mix of Facebook Pages, Instagram professional accounts and Google Business Profile locations. Tabs: **Calendar** (month view in the workspace timezone; click a day to schedule), **Posts** (status per account, links to the live posts, errors, Edit / Post now / Retry / Delete), **Accounts**.
- **Composer**: account chips, caption with live character / hashtag counts for the strictest platform chosen, **Write with AI** (3 caption ideas + hashtags in English/Hindi/Marathi via Groq, cut to platform limits, never inventing prices or dates), link, up to 10 photos/videos (several photos = carousel), schedule in workspace time. Platform rules are checked as you type and again on the server.
- **Accounts**: "Connect Facebook & Instagram" (Facebook Login → Pages + their linked Instagram accounts, Page tokens stored AES-256-GCM encrypted like `ad_oauth_tokens`); "Refresh from Facebook" re-reads Pages from logins already connected in Ads Manager; "Load Google Business locations" uses the existing Google connection (Integrations). Accounts missing a permission or Page role are flagged.
- **Publishing** (`services/social/*`):
  - Facebook: `/feed` (text/link), `/photos`, several photos as unpublished photos + `attached_media`, `/videos`.
  - Instagram: container → poll `status_code` until `FINISHED` → `media_publish`; single image, Reel for video, carousel with children; checks `content_publishing_limit` first. Links are appended to the caption (Instagram has no link posts).
  - Google: `localPosts` STANDARD post, one photo, link as a Learn more button.
  - Media: images are re-encoded to upright JPEG ≤ 1440 px (Instagram takes only JPEG) and stored privately in S3 under `social/{tenantId}/`; platforms fetch them through 24-hour pre-signed links (D6).
- **Scheduling & retries** (`jobs/socialJobs.js`): `social:publish` runs at the post's time (delayed BullMQ job with Redis), `social:sweep` every minute queues anything due (restarts / in-process mode) and releases posts stuck in "publishing" for 30 min. A post is claimed atomically (`scheduled → publishing`) so it can't be published twice. Each account is its own target: temporary errors (throttling, outages, video still processing, Instagram daily limit) retry up to 3 times (2, 4 min); permanent ones (expired login, missing permission, rejected media) fail with the reason; expired logins mark the account. The creator gets a **Social post problems** notification for failures (new toggle in notification settings).
- **API** (`/api/social`, permission `social.publish`): `GET accounts`, `POST accounts/connect`, `POST accounts/refresh`, `POST accounts/gbp`, `PATCH accounts/:id`, `POST media`, `POST captions`, `GET/POST posts`, `GET/PUT/DELETE posts/:id`, `POST posts/:id/publish-now`, `POST posts/:id/retry`, `GET calendar?from&to`.

## Rollout

1. Apply the migration (transactional, safe to re-run) — same way as the earlier ones, from `backend/` with the Parameter Store DB settings loaded:
   `psql -v ON_ERROR_STOP=1 -f models/migration_ads_phase6.sql`
2. Deploy backend, then frontend. No new npm packages, no new env vars.
3. In the Meta app (Curvedlead) → Facebook Login for Business → the configuration used by `VITE_FACEBOOK_LOGIN_CONFIG_ID`: add `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`. Existing connections must reconnect (Social → Accounts → Connect) to grant them.
4. Google: posting needs the Business Profile API (My Business v4 `localPosts`, Account Management, Business Information) enabled and approved for the Google Cloud project. Until then "Load Google Business locations" shows Google's refusal.

## Meta / Google permissions used

`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` (Advanced Access via App Review for client businesses). Google: `business.manage` (existing scope).

## Not in this phase

- Facebook Reels (videos go to Facebook as regular video posts) and Instagram Stories.
- Editing or deleting posts on the platforms after publishing (CurveLead's Delete only removes its own record).
- Engagement stats (likes, reach) for published posts.
- Staff access: the page is admin-only in the menu, like Ads Manager; the API also allows staff with `social.publish`.
- Video dimension/length checks happen on Meta's side (errors come back as the target's reason).
