---
name: syncloud-house-style
description: House style for any Omega UI / SynCloud Connect work — official names, platform terms, brand voice and word-level guardrails. Use before writing or editing any text, code comments, UI copy, docs or commit messages that touch the platform. Source of truth is the repo's CONTEXT.md; if this file and CONTEXT.md disagree, CONTEXT.md wins and this skill should be updated.
---

# SynCloud house style

The shared language of the SynCloud Connect platform, built by Omega UI, LLC for local brick-and-mortar businesses. Use these exact terms everywhere; the _Avoid_ list is enforced, not advisory.

## Organisations

- **Omega UI** — the company (Omega UI, LLC) that builds, owns and licenses the platform. Avoid: Omega (alone), the LLC.
- **SynCloud Connect** — the platform Clients and their Customers sign into, made up of the apps and Optiq beneath them. Avoid: Cloud Connect, SynCloudConnect, SynCloud, command center.
- **Optiq** — the engine beneath SynCloud Connect that Customers never see: UCP, the Agents and the data. Avoid: Arc, the backend, command center, the system.
- **Client** — a business that subscribes to SynCloud Connect. Sweet Cypress Ranch is Client #1. Avoid: tenant, sub-account, entity, store (for the business).
- **Location** — one physical premises of a Client, with its own stock (e.g. SCR's Fort Myers and LaBelle). Avoid: store, branch, shop.

## People

- **Customer** — a person who buys from a Client. Avoid: user, buyer, client (for the person).
- **Member** — a Customer who has joined the Stars Club, as a Free Member or a Paid Member. Avoid: subscriber, VIP.
- **Paid Member** — a Member on the paid tier, which carries the Stars Club perks such as priority delivery. Avoid: premium member, Bronze/Silver/Gold/Platinum.

## Stars Club

- **Stars Club** — the platform-wide membership program a Client's Customers can join, priced by Omega UI and shown under the Client's name (e.g. "SCR Stars Club"); its income goes to Omega UI, not to the Client. Avoid: loyalty program, rewards club, tiers.
- **Stars** — points a Member earns from purchases, birthdays, referrals, repeat buys and paying the membership. Stars never reduce the price of a sale. Avoid: loyalty points, rewards points, credits, discount.

## Products

- **QRAPID** — the inventory product a Client subscribes to, keeping each Location's stock in step across counter, online and off-site sales. Avoid: Omega QR system, Omega QR solution, Omega QRAPID.

## UCP

- **UCP** — the Universal Command Protocol: a deterministic way to express and transport Commands instead of free-form prompts. UCP never means the screen. Avoid: Universal Control Panel.
- **Control Panel** — the screen where a person sends requests into Optiq and reads the results. Avoid: UCP, Universal Control Panel, dashboard (for this screen).
- **B.R.A.D.Y.** — the engine inside Optiq that routes each request to the right compute (GPU, legacy AI services or real-time streams) and turns the raw result into readable output. Avoid: Brady, BRADY engine, router.
- **Command** — a named, defined action listed in the Dictionary. Avoid: instruction, prompt, macro.
- **Dictionary** — the set of Command definitions a sender and Receiver agree on. Avoid: command list, registry, codebook.
- **Payload** — the normalised inputs that accompany a Command. Avoid: arguments, params, body.
- **Packet** — a Command and its Payload, encoded with a content digest so it can travel over any transport (QR, HTTP, mesh). Avoid: message, token, request.
- **Receiver** — the side that validates, deduplicates and executes Packets. Avoid: listener, consumer, handler.
- **Repeat Bridge** — Omega UI's reference app for creating and transporting Packets; an application of UCP, not the protocol itself. Never call the app "UCP".

## Agents

- **Agent** — an AI that acts on the platform within set permissions; a human keeps the final say. Avoid: butler, bot, AI employee, assistant.
- **GLYTCH** — Omega UI's own Agent and mascot. Pronounced "glitch". Avoid: Glitch, GLITCH.
- **GLYNDA** — the Agent that assists GLYTCH, taking on work GLYTCH hands her. Avoid: Glinda, GLINDA.
- **Customer Agent** — the Agent role that serves a Client's Customers. SCR's Customer Agent is named Cowboy. Avoid: chatbot, front-desk bot.
- **Staff Agent** — the Agent role that serves a Client's owner and staff from the inside. SCR's Staff Agent is named Pablo. Avoid: back-office bot, admin AI.
- **TYRQ** — a score of how well one person and one Agent are working together, which can rise or fall. Pronounced "tork". Avoid: Torc, Torche, TorQ, synergy score.

## Guardrails

1. Capitalisation and punctuation are part of the term: GLYTCH, GLYNDA, QRAPID, UCP, B.R.A.D.Y., Stars Club, SynCloud Connect, Optiq. Fix wrong forms on sight.
2. Never rename platform concepts to generic industry words (tenant, loyalty points, dashboard, bot) — the Avoid lists exist because those words caused real confusion.
3. A human keeps the final say is a brand stance, not a suggestion: copy about Agents must never imply they act without approval.
4. Stars never reduce the price of a sale — never describe them as discounts or credits.
5. Each app keeps its own CONTEXT.md for words only it uses; platform-wide terms belong in the root CONTEXT.md, and this skill mirrors it.
