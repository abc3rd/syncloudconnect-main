# GLYTCH ⇄ GoHighLevel Bridge

Omega UI, LLC / SynCloud Connect · v1.0

GLYTCH reads your GoHighLevel data instantly. It also does the tedious cleanup work on its own: fixing formats, finding duplicates and flagging stale deals. **Nothing changes in GoHighLevel until you approve it.**

## How it protects your data

| Rule | How |
|---|---|
| Your GoHighLevel token is never in a browser | It lives only in Vercel environment variables |
| Reads run immediately | Contacts, opportunities, tags, pipelines, conversations, calendars |
| Every edit waits for you | Edits become proposals in the approval queue |
| GLYTCH can't approve its own work | Two keys: the **agent key** reads and proposes; only the **admin key** approves |
| No surprise overwrites | Before an approved edit runs, the record is re-checked. If it changed since the proposal, the edit is held so you can look again |
| Deletes are extra-guarded | You must type `DELETE`, and deletes are never bulk-approved |
| Everything is recorded | Audit log of every proposal, approval, rejection and job run |

## Setup (about 15 minutes, $0 extra)

### 1. Create your GoHighLevel token
In your GoHighLevel sub-account, open **Settings → Private Integrations → Create New Integration**. Give it these scopes:
- View/Edit Contacts
- View/Edit Opportunities
- View Conversations
- View Calendars
- View Locations
- View Tags
- View Custom Fields

Copy the token. GoHighLevel only shows it once.

Your **Location ID** is in Settings → Business Profile, or in the address bar (`/location/XXXX/`).

### 2. Free storage for the approval queue
In Vercel, open **Storage** and add **Upstash Redis** (free tier). It adds `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to the project for you. Without it, the queue resets whenever Vercel restarts the function.

### 3. Deploy on Vercel
Import this repo, set **Root Directory** to `glytch-ghl`, set Framework to **Other**, leave the build command empty, and add these environment variables:

| Variable | Value |
|---|---|
| `GHL_PIT` | the token from step 1 |
| `GHL_LOCATION_ID` | your location ID |
| `GLYTCH_ADMIN_KEY` | a long random password; **yours only**, used to approve |
| `GLYTCH_AGENT_KEY` | a different long random password, for GLYTCH / AI agents |
| `CRON_SECRET` | a third random string (Vercel uses it for the daily job run) |

Make a random key: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`

### 4. Open GLYTCH
Visit your Vercel address, go to **Settings**, paste the **admin** key, and click Connect. The top bar should show your location name in green.

## Using it

- **Approvals:** every pending change, showing before and after and why. Approve, reject, or approve several at once.
- **Data:** search contacts and opportunities. Click a contact to propose changes, tags, notes or a delete.
- **Tasks:** run cleanup now. They also run daily at 13:17 UTC (≈ 8:17 AM Eastern) on their own.
  - **Fix formatting:** phones to +1 format, email typos, ALL-CAPS names.
  - **Find duplicates:** tags contacts that share an email or phone `glytch-duplicate`, so you can merge them in GoHighLevel. The API has no merge, so GLYTCH flags rather than merges.
  - **Stale deals:** tags the contact on any open opportunity with no movement in 14 days `glytch-follow-up`. Point a GoHighLevel workflow at that tag to send the follow-up.
  - **Tag cleanup report:** lists near-duplicate tags.
- **Log:** the full audit trail.

## Connecting GLYTCH or another AI agent

Give the agent the **agent key** only. It can:
```
GET  /api/read?op=contacts.search&query=smith
GET  /api/read?op=opportunities.search&status=open
POST /api/proposals   {"op":"contact.update","targetId":"<id>","payload":{"phone":"+12395550123"},"reason":"..."}
POST /api/proposals   {"items":[ ...up to 200 proposals... ]}
POST /api/jobs        {"job":"all"}
```
Edit types: `contact.update`, `contact.addTags`, `contact.removeTags`, `contact.addNote`, `contact.create`, `contact.delete`, `opportunity.update`.
Reads: `location`, `contacts.search`, `contact.get`, `contact.notes`, `tags`, `customFields`, `pipelines`, `opportunities.search`, `opportunity.get`, `conversations.search`, `calendars`.

The agent can never call `/api/decide`. That's yours.

## Your $97 plan

Starter includes basic API access through a sub-account Private Integration Token, which is exactly what this uses. It works on one sub-account per token; to cover a second sub-account, deploy a second copy with that sub-account's token.

## First live run checklist

The bridge was tested end to end against a mock GoHighLevel (`npm test`, 35 checks). On your first live connection:
1. Settings: the top bar shows your location name. If not, re-check the token scopes and Location ID.
2. Data: search a contact you know.
3. Tasks: run **Fix formatting** and read the proposals. Approve one and confirm the change in GoHighLevel.

If any GoHighLevel call returns an error, it shows the exact message in the UI and the log. API paths are in one place (`api/_lib.js`, `READS` and `EDITS`) if anything needs adjusting.
