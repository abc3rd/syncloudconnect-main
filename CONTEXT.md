# SynCloud Connect

The shared language of the SynCloud Connect platform, built by Omega UI, LLC for local brick-and-mortar businesses. Terms used by every app live here; each app keeps its own `CONTEXT.md` for words only it uses and points back to this one.

## Organisations

**Omega UI**:
The company (Omega UI, LLC) that builds, owns and licenses the platform.
_Avoid_: Omega (alone), the LLC

**SynCloud Connect**:
The platform Clients and their Customers sign into, made up of the apps and Optiq beneath them.
_Avoid_: Cloud Connect, SynCloudConnect, SynCloud, command center

**Optiq**:
The engine beneath SynCloud Connect that Customers never see: UCP, the Agents and the data.
_Avoid_: Arc, the backend, command center, the system

**Client**:
A business that subscribes to SynCloud Connect. Sweet Cypress Ranch is Client #1.
_Avoid_: tenant, sub-account, entity, store (for the business)

**Location**:
One physical premises of a Client, with its own stock (e.g. SCR's Fort Myers and LaBelle).
_Avoid_: store, branch, shop

## People

**Customer**:
A person who buys from a Client.
_Avoid_: user, buyer, client (for the person)

**Member**:
A Customer who has joined the Stars Club, as a Free Member or a Paid Member.
_Avoid_: subscriber, VIP

**Paid Member**:
A Member on the paid tier, which carries the Stars Club perks such as priority delivery.
_Avoid_: premium member, Bronze/Silver/Gold/Platinum

## Stars Club

**Stars Club**:
The platform-wide membership program a Client's Customers can join, priced by Omega UI and shown under the Client's name (e.g. "SCR Stars Club"); its income goes to Omega UI, not to the Client.
_Avoid_: loyalty program, rewards club, tiers

**Stars**:
Points a Member earns from purchases, birthdays, referrals, repeat buys and paying the membership. Stars never reduce the price of a sale.
_Avoid_: loyalty points, rewards points, credits, discount

## Products

**QRAPID**:
The inventory product a Client subscribes to, keeping each Location's stock in step across counter, online and off-site sales.
_Avoid_: Omega QR system, Omega QR solution, Omega QRAPID

## UCP

**UCP**:
The Universal Command Protocol: a deterministic way to express and transport Commands instead of free-form prompts.
_Avoid_: Universal Control Panel (UCP never means the screen)

**Control Panel**:
The screen where a person sends requests into Optiq and reads the results.
_Avoid_: UCP, Universal Control Panel, dashboard (for this screen)

**B.R.A.D.Y.**:
The engine inside Optiq that routes each request to the right compute (GPU, legacy AI services or real-time streams) and turns the raw result into readable output.
_Avoid_: Brady, BRADY engine, router

**Command**:
A named, defined action listed in the Dictionary.
_Avoid_: instruction, prompt, macro

**Dictionary**:
The set of Command definitions a sender and Receiver agree on.
_Avoid_: command list, registry, codebook

**Payload**:
The normalised inputs that accompany a Command.
_Avoid_: arguments, params, body

**Packet**:
A Command and its Payload, encoded with a content digest so it can travel over any transport (QR, HTTP, mesh).
_Avoid_: message, token, request

**Receiver**:
The side that validates, deduplicates and executes Packets.
_Avoid_: listener, consumer, handler

**Repeat Bridge**:
Omega UI's reference app for creating and transporting Packets; an application of UCP, not the protocol itself.
_Avoid_: UCP (for the app)

## Agents

**Agent**:
An AI that acts on the platform within set permissions; a human keeps the final say.
_Avoid_: butler, bot, AI employee, assistant

**GLYTCH**:
Omega UI's own Agent and mascot. Pronounced "glitch".
_Avoid_: Glitch, GLITCH

**GLYNDA**:
The Agent that assists GLYTCH, taking on work GLYTCH hands her.
_Avoid_: Glinda, GLINDA

**Customer Agent**:
The Agent role that serves a Client's Customers. SCR's Customer Agent is named Cowboy.
_Avoid_: chatbot, front-desk bot

**Staff Agent**:
The Agent role that serves a Client's owner and staff from the inside. SCR's Staff Agent is named Pablo.
_Avoid_: back-office bot, admin AI

**TYRQ**:
A score of how well one person and one Agent are working together, which can rise or fall. Pronounced "tork".
_Avoid_: Torc, Torche, TorQ, synergy score
