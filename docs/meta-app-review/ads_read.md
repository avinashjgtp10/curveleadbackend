# App Review — ads_read (Advanced Access)

App: **Curvedlead** (App ID 1551778202757963), Facebook Login for Business configuration 4416725028596340.
Product: **CurveLead** (https://curvelead.com), a lead-management CRM for small businesses in India.

---

## a) Submission notes

Paste into "Tell us how you'll use ads_read" / "Describe how your app uses this permission".

> **What CurveLead is:** CurveLead is a lead-management CRM used by small businesses in India, such as salons, clinics, coaching institutes and real-estate agents. Many of them run Facebook and Instagram lead ads and want to know which ads bring customers, not just clicks or form fills.
>
> **Where ads_read is used:** In CurveLead, the business admin opens **Ads Manager → Meta Ads** and clicks **Connect with Facebook**. Facebook Login for Business asks them to grant ad access. CurveLead then lists the ad accounts they can access, and they choose one as primary. **Sync now** (or **Sync ad insights** on the Campaigns tab) loads their ad data, and CurveLead refreshes it automatically every 4 hours.
>
> **What data we read (only from the ad accounts the person connected):**
> - The person's ad accounts (`GET /me/adaccounts`): id, name, currency, timezone, account status.
> - The campaign → ad set → ad structure of each connected account: names, objective, status, budgets, start and end dates, and each ad's creative title, text and thumbnail.
> - Daily performance per ad for the last 90 days, then the most recent 3 days on each refresh (`GET /act_{id}/insights`): spend, impressions, clicks, CTR, CPC, lead actions and cost per lead.
>
> **How it adds value:** CurveLead shows each campaign's spend and Meta-reported leads next to what happened to those leads in the CRM: how many qualified, how many became customers, and the cost per qualified lead and per customer. For example, an owner can see that one ad has a low cost per lead but no customers, while another costs more per lead but brings paying customers, and move budget accordingly. Without ads_read, CurveLead cannot read spend or ad results, so this comparison, the core of our Ads Manager, is impossible.
>
> **Whose data:** A person only ever sees the ad accounts their own Facebook login has access to. Data is stored per CurveLead workspace and is visible only to that workspace's admins (and staff they explicitly allow). We do not show one business's ad data to another, do not sell or share ad data, and do not use it to build audiences or target ads. Access tokens are stored encrypted on our servers. When their Facebook login expires or is revoked, syncing stops until they reconnect.
>
> **Why Advanced Access:** Our customers are independent businesses that are not part of our Business Manager and have no role on our app, so Standard Access never offers them ads_read.

**Also provide in the submission:**
- A CurveLead test login (email + password) for the reviewer, in a workspace with nothing connected yet, plus the Facebook test user or ad account to use.
- **Platform:** Web; **URL:** https://curvelead.com.
- Submit together with the permissions shown in the same flow: `business_management` (ad accounts owned through a Business Manager) and, if requested, `ads_management` (pause/resume and budgets in Ads Manager).

---

## b) Screencast script

Record at 1280×720 or larger, English UI, one continuous take (no cuts between steps), with the cursor visible. Add each caption as on-screen text for 3–5 seconds when that step starts.

Before recording:
- Use a Facebook account that has a real ad account with some spend in the last 30 days.
- Use a CurveLead workspace with **no** Meta ad account connected, so the full connect flow shows.
- Log out of Facebook in this browser, so the Facebook login screen appears. If you can't, at least remove Curvedlead from Facebook → Settings → Business integrations first.

| # | Action on screen | Caption |
|---|---|---|
| 1 | Show the browser at https://curvelead.com and sign in to CurveLead with the test account. | "CurveLead is a CRM for small businesses. The business owner signs in to their CurveLead workspace." |
| 2 | Click **Grow → Ads Manager** in the sidebar, then the **Meta Ads** tab. Show the empty "Connect your Meta ad accounts" card. | "In Ads Manager → Meta Ads, the owner connects their Facebook ad account to see ad results next to their leads." |
| 3 | Click **Connect with Facebook**. The Facebook popup opens. | "CurveLead uses Facebook Login for Business." |
| 4 | Sign in to Facebook with the test user's email and password. | "The owner logs in with their own Facebook account." |
| 5 | On Facebook's permission screen, slowly scroll through the requested permissions and hover over **ad accounts / ads_read**. Keep everything selected. If Facebook asks which businesses or ad accounts to share, select the ad account. | "Facebook asks the owner to allow CurveLead to read their ad account performance (ads_read)." |
| 6 | Click **Continue / Save**, and wait for the popup to close. | "The owner grants access. Only the ad accounts they chose are shared." |
| 7 | Back in CurveLead, show the success message and the **"Facebook gave CurveLead these permissions"** box, with "Read ad performance: ✓ granted". | "CurveLead confirms which permissions were granted." |
| 8 | Show the ad account in the account picker at the top (open the dropdown if there are several). | "CurveLead lists the ad accounts this login can access (GET /me/adaccounts)." |
| 9 | Click **Sync now** and show the "Sync started" message. Optionally go to the **Campaigns** tab and click **Sync ad insights**. | "Sync reads campaigns, ad sets, ads and daily insights from the Marketing API using ads_read." |
| 10 | Wait until the data loads (refresh after 1–2 minutes if needed; cut out the waiting only if you must, and say so in a caption). Show the totals: Spend, Reported by Meta, In CurveLead, Cost per customer. | "Spend and Meta-reported leads for the last 30 days, read with ads_read." |
| 11 | Scroll the campaign table (spend, impressions, CTR, CPC, leads, CPL). Click one campaign, then one ad set, to show its ads with thumbnail, title and text. | "Drill down from campaign to ad set to ad: performance and creative for each ad." |
| 12 | Scroll to **Lead quality by campaign**. Point at "Leads in CurveLead", "Cost / qualified" and "Cost / customer". | "The value for the business: ad spend next to which leads qualified and became customers in the CRM." |
| 13 | Change the date range (Last 7 days → Last 90 days) and show the numbers update. | "Owners compare periods to decide where to spend their budget." |
| 14 | End on the Meta Ads tab. | "CurveLead only shows each business its own ad accounts. Data is not shared with anyone else." |

**Check before uploading**

- Steps 3–6 show Facebook's own login and permission screens. This is what the previous rejection asked for.
- ads_read is visibly granted (step 5) and visibly used: ad accounts listed (step 8), sync run (step 9), insights shown (steps 10–12).
- No other business's data, real customer names or phone numbers appear. Blur them if they do.
- The video is in English and has no music that hides the captions.
