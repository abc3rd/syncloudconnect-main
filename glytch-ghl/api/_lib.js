// GLYTCH ⇄ GoHighLevel bridge — shared library
// Omega UI, LLC / SynCloud Connect
//
// Rules this bridge enforces:
//   1. The GoHighLevel token lives only in server environment variables.
//   2. Reads run immediately.
//   3. Every edit becomes a *proposal*. Nothing changes in GoHighLevel until an
//      admin approves it. The agent key can read and propose, never approve.
//   4. Before an approved edit runs, the record is re-fetched; if it changed since
//      the proposal was made, the edit is held as "stale" for a fresh look.
//   5. Everything is written to an audit log.

import crypto from "node:crypto";

export const GHL_BASE = process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com";
export const GHL_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const LOCATION_ID = () => process.env.GHL_LOCATION_ID || "";

// ---------------------------------------------------------------- auth
function safeEq(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Returns "admin" | "agent" | "cron" | null */
export function roleOf(req) {
  const key = req.headers["x-glytch-key"] || "";
  if (safeEq(key, process.env.GLYTCH_ADMIN_KEY)) return "admin";
  if (safeEq(key, process.env.GLYTCH_AGENT_KEY)) return "agent";
  const auth = req.headers["authorization"] || "";
  if (process.env.CRON_SECRET && safeEq(auth, `Bearer ${process.env.CRON_SECRET}`)) return "cron";
  return null;
}

export function requireRole(req, res, allowed) {
  const role = roleOf(req);
  if (!role || !allowed.includes(role)) {
    send(res, role ? 403 : 401, { error: role ? "This key can't do that." : "Missing or wrong GLYTCH key." });
    return null;
  }
  return role;
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function configStatus() {
  return {
    ghlToken: !!process.env.GHL_PIT,
    locationId: !!LOCATION_ID(),
    adminKey: !!process.env.GLYTCH_ADMIN_KEY,
    agentKey: !!process.env.GLYTCH_AGENT_KEY,
    storage: process.env.UPSTASH_REDIS_REST_URL ? "upstash" : "memory (not saved between runs: add Upstash)",
    cron: !!process.env.CRON_SECRET,
  };
}

// ---------------------------------------------------------------- GoHighLevel client
let lastCall = 0;
export async function ghl(method, path, { query, body } = {}) {
  if (!process.env.GHL_PIT) throw new Error("GHL_PIT is not set on the server.");
  // gentle pacing: at most ~8 calls per second from one function run
  const wait = lastCall + 125 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  const url = new URL(GHL_BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GHL_PIT}`,
      Version: GHL_VERSION,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`GoHighLevel ${r.status}: ${data.message || data.error || text.slice(0, 200)}`);
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- read operations (run immediately)
export const READS = {
  "location":        () => ghl("GET", `/locations/${LOCATION_ID()}`),
  "contacts.search": ({ query = "", page = 1, limit = 50 }) =>
      ghl("POST", "/contacts/search", { body: { locationId: LOCATION_ID(), query, page: Number(page), pageLimit: Math.min(Number(limit) || 50, 100) } }),
  "contact.get":     ({ id }) => ghl("GET", `/contacts/${enc(id)}`),
  "contact.notes":   ({ id }) => ghl("GET", `/contacts/${enc(id)}/notes`),
  "tags":            () => ghl("GET", `/locations/${LOCATION_ID()}/tags`),
  "customFields":    () => ghl("GET", `/locations/${LOCATION_ID()}/customFields`),
  "pipelines":       () => ghl("GET", "/opportunities/pipelines", { query: { locationId: LOCATION_ID() } }),
  "opportunities.search": ({ q = "", status = "", page = 1, limit = 50, pipeline_id = "" }) =>
      ghl("GET", "/opportunities/search", { query: { location_id: LOCATION_ID(), q, status, page, limit: Math.min(Number(limit) || 50, 100), pipeline_id } }),
  "opportunity.get": ({ id }) => ghl("GET", `/opportunities/${enc(id)}`),
  "conversations.search": ({ query = "", limit = 20 }) =>
      ghl("GET", "/conversations/search", { query: { locationId: LOCATION_ID(), query, limit } }),
  "calendars":       () => ghl("GET", "/calendars/", { query: { locationId: LOCATION_ID() } }),
};

// ---------------------------------------------------------------- edit operations (queued, need approval)
// snapshot(): what the record looks like now (shown as "before", and used for the stale check)
// execute(): the actual GoHighLevel call, run only after approval
const contactSnap = async id => (await ghl("GET", `/contacts/${enc(id)}`)).contact || null;
const oppSnap = async id => (await ghl("GET", `/opportunities/${enc(id)}`)).opportunity || null;

export const EDITS = {
  "contact.update": {
    label: "Update contact fields", destructive: false,
    snapshot: p => contactSnap(p.targetId),
    execute: p => ghl("PUT", `/contacts/${enc(p.targetId)}`, { body: p.payload }),
  },
  "contact.addTags": {
    label: "Add tags", destructive: false,
    snapshot: p => contactSnap(p.targetId),
    execute: p => ghl("POST", `/contacts/${enc(p.targetId)}/tags`, { body: { tags: p.payload.tags } }),
  },
  "contact.removeTags": {
    label: "Remove tags", destructive: false,
    snapshot: p => contactSnap(p.targetId),
    execute: p => ghl("DELETE", `/contacts/${enc(p.targetId)}/tags`, { body: { tags: p.payload.tags } }),
  },
  "contact.addNote": {
    label: "Add note", destructive: false,
    snapshot: p => contactSnap(p.targetId),
    execute: p => ghl("POST", `/contacts/${enc(p.targetId)}/notes`, { body: { body: p.payload.body } }),
  },
  "contact.create": {
    label: "Create contact", destructive: false,
    snapshot: async () => null,
    execute: p => ghl("POST", "/contacts/", { body: { ...p.payload, locationId: LOCATION_ID() } }),
  },
  "contact.delete": {
    label: "DELETE contact", destructive: true,
    snapshot: p => contactSnap(p.targetId),
    execute: p => ghl("DELETE", `/contacts/${enc(p.targetId)}`),
  },
  "opportunity.update": {
    label: "Update opportunity", destructive: false,
    snapshot: p => oppSnap(p.targetId),
    execute: p => ghl("PUT", `/opportunities/${enc(p.targetId)}`, { body: p.payload }),
  },
};

const enc = s => encodeURIComponent(String(s || ""));

// stale check: compare only fields that both a search result and a full fetch carry
const FP_FIELDS = ["firstName", "lastName", "email", "phone", "companyName", "tags", "name", "status", "pipelineStageId", "monetaryValue", "assignedTo"];
export function fingerprint(rec) {
  if (!rec) return null;
  const pick = {};
  for (const f of FP_FIELDS) {
    let v = rec[f];
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v = [...v].map(String).sort();
    pick[f] = v;
  }
  return crypto.createHash("sha1").update(JSON.stringify(pick)).digest("hex");
}

// ---------------------------------------------------------------- storage (Upstash Redis REST, or memory for local tests)
const mem = globalThis.__glytchMem || (globalThis.__glytchMem = { hash: {}, list: [] });

async function redis(cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error("Storage: " + j.error);
  return j.result;
}
const useRedis = () => !!process.env.UPSTASH_REDIS_REST_URL;
const P = "glytch:proposals", L = "glytch:log";

export const store = {
  async put(p) {
    if (useRedis()) await redis(["HSET", P, p.id, JSON.stringify(p)]);
    else mem.hash[p.id] = JSON.stringify(p);
    return p;
  },
  async get(id) {
    const v = useRedis() ? await redis(["HGET", P, id]) : mem.hash[id];
    return v ? JSON.parse(v) : null;
  },
  async all() {
    if (useRedis()) {
      const flat = (await redis(["HGETALL", P])) || [];
      const out = [];
      for (let i = 1; i < flat.length; i += 2) out.push(JSON.parse(flat[i]));
      return out;
    }
    return Object.values(mem.hash).map(v => JSON.parse(v));
  },
  async log(entry) {
    const e = JSON.stringify({ at: new Date().toISOString(), ...entry });
    if (useRedis()) { await redis(["LPUSH", L, e]); await redis(["LTRIM", L, "0", "999"]); }
    else { mem.list.unshift(e); mem.list.length = Math.min(mem.list.length, 1000); }
  },
  async logs(n = 200) {
    const arr = useRedis() ? (await redis(["LRANGE", L, "0", String(n - 1)])) || [] : mem.list.slice(0, n);
    return arr.map(x => JSON.parse(x));
  },
};

// ---------------------------------------------------------------- proposals
export async function createProposal({ op, targetId = null, payload = {}, reason = "", source = "manual" }, knownBefore) {
  const def = EDITS[op];
  if (!def) throw Object.assign(new Error(`Unknown edit "${op}". Allowed: ${Object.keys(EDITS).join(", ")}`), { status: 400 });
  if (op !== "contact.create" && !targetId) throw Object.assign(new Error("targetId is required."), { status: 400 });
  // one pending proposal per op+target+payload: jobs can rerun without piling up duplicates
  const dedupeKey = crypto.createHash("sha1").update(`${op}|${targetId}|${JSON.stringify(payload)}`).digest("hex").slice(0, 16);
  const existing = (await store.all()).find(x => x.dedupeKey === dedupeKey && x.status === "pending");
  if (existing) return { proposal: existing, duplicate: true };
  // jobs pass the record they just read, saving one GoHighLevel call per proposal
  const before = knownBefore !== undefined ? knownBefore : await def.snapshot({ targetId, payload });
  if (op !== "contact.create" && !before) throw Object.assign(new Error(`Record ${targetId} not found.`), { status: 404 });
  const p = {
    id: "p_" + crypto.randomBytes(6).toString("hex"),
    op, label: def.label, destructive: def.destructive,
    targetId, payload, reason, source, dedupeKey,
    before, fingerprint: fingerprint(before),
    status: "pending", createdAt: new Date().toISOString(),
  };
  await store.put(p);
  await store.log({ event: "proposed", id: p.id, op, targetId, source, reason });
  return { proposal: p, duplicate: false };
}

export async function decide(id, decision, { confirmText = "", force = false, decidedBy = "admin" } = {}) {
  const p = await store.get(id);
  if (!p) throw Object.assign(new Error("Proposal not found."), { status: 404 });
  if (!["pending", "stale"].includes(p.status)) throw Object.assign(new Error(`Already ${p.status}.`), { status: 409 });
  if (decision === "reject") {
    Object.assign(p, { status: "rejected", decidedAt: new Date().toISOString(), decidedBy });
    await store.put(p); await store.log({ event: "rejected", id, op: p.op, targetId: p.targetId, decidedBy });
    return p;
  }
  if (decision !== "approve") throw Object.assign(new Error('decision must be "approve" or "reject".'), { status: 400 });
  if (p.destructive && confirmText !== "DELETE") {
    throw Object.assign(new Error('This deletes data. Send confirmText: "DELETE" to approve it.'), { status: 428 });
  }
  const def = EDITS[p.op];
  const now = await def.snapshot(p);
  if (p.op !== "contact.create") {
    if (!now) {
      Object.assign(p, { status: "failed", result: "Record no longer exists.", decidedAt: new Date().toISOString(), decidedBy });
      await store.put(p); await store.log({ event: "failed", id, reason: "missing" }); return p;
    }
    if (!force && fingerprint(now) !== p.fingerprint) {
      Object.assign(p, { status: "stale", before: now, fingerprint: fingerprint(now) });
      await store.put(p); await store.log({ event: "stale", id, op: p.op, targetId: p.targetId });
      return p; // shown again with the fresh "before"; approve again to run it
    }
  }
  try {
    const result = await def.execute(p);
    Object.assign(p, { status: "done", result, decidedAt: new Date().toISOString(), decidedBy });
    await store.put(p); await store.log({ event: "executed", id, op: p.op, targetId: p.targetId, decidedBy });
  } catch (e) {
    Object.assign(p, { status: "failed", result: e.message, decidedAt: new Date().toISOString(), decidedBy });
    await store.put(p); await store.log({ event: "failed", id, op: p.op, error: e.message });
  }
  return p;
}

export function handleError(res, e) {
  send(res, e.status && e.status < 600 ? e.status : 500, { error: e.message });
}
