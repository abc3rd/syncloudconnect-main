---
name: glytch-ghl-bridge
description: Read or propose changes to live GoHighLevel data through the GLYTCH ⇄ GoHighLevel bridge (glytch-ghl/, deployed on Vercel). Use whenever an agent needs real contact, opportunity, tag, pipeline, conversation or calendar data, or wants to change any of it.
---

# GLYTCH ⇄ GoHighLevel Bridge

GLYTCH reads GoHighLevel data instantly and prepares cleanup work, but **nothing changes in GoHighLevel until a human approves it**. You work with the agent key only. The admin key belongs to the owner.

## Non-negotiable rules

1. **Reads run immediately; every edit is a proposal.** Never claim data was changed — it was proposed.
2. **Never call `/api/decide`.** That endpoint is admin-key only. Do not ask for the admin key; if a task requires it, hand the approval step back to the owner.
3. **Deletes are extra-guarded** — they require the owner to type `DELETE` and are never bulk-approved. Propose deletes sparingly and always with a reason.
4. **No surprise overwrites** — the bridge re-checks each record before an approved edit runs and holds it if the record changed. Don't re-propose identical edits in a loop; tell the owner it was held.
5. **Everything is audited** — every proposal, approval, rejection and job run is logged. Write clear `reason` strings; the owner reads them.
6. The GoHighLevel token lives only in Vercel environment variables. Never ask for it, print it, or put it in a browser.

## Endpoints (agent key)

```
GET  /api/read?op=contacts.search&query=smith
GET  /api/read?op=opportunities.search&status=open
POST /api/proposals   {"op":"contact.update","targetId":"<id>","payload":{"phone":"+12395550123"},"reason":"..."}
POST /api/proposals   {"items":[ ...up to 200 proposals... ]}
POST /api/jobs        {"job":"all"}
```

**Reads:** `location`, `contacts.search`, `contact.get`, `contact.notes`, `tags`, `customFields`, `pipelines`, `opportunities.search`, `opportunity.get`, `conversations.search`, `calendars`.

**Proposal ops:** `contact.update`, `contact.addTags`, `contact.removeTags`, `contact.addNote`, `contact.create`, `contact.delete`, `opportunity.update`.

## Cleanup jobs (also run daily at 13:17 UTC)

- **Fix formatting** — phones to +1 format, email typos, ALL-CAPS names.
- **Find duplicates** — tags contacts sharing an email or phone `glytch-duplicate`. The API has no merge, so GLYTCH flags rather than merges; merging is a human step in GoHighLevel.
- **Stale deals** — tags the contact on any open opportunity with no movement in 14 days `glytch-follow-up`. Pair with a GoHighLevel workflow on that tag.
- **Tag cleanup report** — lists near-duplicate tags.

## Error handling

- GoHighLevel errors surface verbatim in the UI and the log — report them as-is, don't paraphrase or guess fixes.
- API paths live in one place: `api/_lib.js` (`READS` and `EDITS`). If GoHighLevel changes an endpoint, that's the file to patch — propose the change, don't hot-patch production.
- One token covers one sub-account. A second sub-account means a second deployment; don't try to stretch one token across accounts.
