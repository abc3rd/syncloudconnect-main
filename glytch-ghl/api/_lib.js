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
import fs from "node:fs";
import path from "node:path";

export const GHL_BASE = process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com";
export const GHL_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------- locations (one or many sub-accounts)
// GHL_LOCATIONS="scr=Yi87...,omega-ui=ZWn4..."  (or a single GHL_LOCATION_ID)
export function locations() {
  const out = {};
  for (const part of (process.env.GHL_LOCATIONS || "").split(",")) {
    const [k, v] = part.split("=").map(x => (x || "").trim());
    if (k && v) out[k] = v;
  }
  if (!Object.keys(out).length && process.env.GHL_LOCATION_ID) out.default = process.env.GHL_LOCATION_ID;
  return out;
}
const als = new AsyncLocalStorage();
export function defaultLocationKey() { return Object.keys(locations())[0] || ""; }
/** Run fn with a sub-account selected (by key like "scr" or a raw location ID). */
export function withLocation(keyOrId, fn) {
  const locs = locations();
  const key = keyOrId && locs[keyOrId] ? keyOrId : (Object.entries(locs).find(([, v]) => v === keyOrId)?.[0] || defaultLocationKey());
  return als.run({ key, id: locs[key] || "" }, fn);
}
export function locationFromReq(req) {
  const u = new URL(req.url, "http://x");
  return req.headers["x-glytch-location"] || u.searchParams.get("loc") || "";
}
export const currentLocationKey = () => als.getStore()?.key || defaultLocationKey();
const LOCATION_ID = () => als.getStore()?.id || locations()[defaultLocationKey()] || "";

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
    ghlToken: !!process.env.GHL_PIT || Object.keys(process.env).some(k => k.startsWith("GHL_PIT_")),
    locations: Object.keys(locations()),
    currentLocation: currentLocationKey(),
    adminKey: !!process.env.GLYTCH_ADMIN_KEY,
    agentKey: !!process.env.GLYTCH_AGENT_KEY,
    storage: process.env.UPSTASH_REDIS_REST_URL ? "upstash" : process.env.GLYTCH_DATA_DIR ? "disk (" + process.env.GLYTCH_DATA_DIR + ")" : "memory (not saved between runs)",
    cron: !!process.env.CRON_SECRET,
  };
}

// ---------------------------------------------------------------- GoHighLevel client
let lastCall = 0;
// Which token to use for a location:
//   GHL_PIT_<KEY> (e.g. GHL_PIT_SCR): a sub-account token for that location, used as-is
//   otherwise GHL_PIT: tried as-is; if GoHighLevel says it's the wrong token type (agency token),
//   it's exchanged for a short-lived location token via /oauth/locationToken and cached.
const tokenMode = {};            // locationId -> "direct" | "exchange"
const locTokens = {};            // locationId -> { token, exp }
const companyIds = {};           // locationId -> companyId
const exchangeFailed = {};       // locationId -> reason the exchange was refused

export function resetTokenCache() {
  for (const m of [tokenMode, locTokens, exchangeFailed]) for (const k of Object.keys(m)) delete m[k];
}

function baseToken() {
  const k = currentLocationKey().toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return process.env["GHL_PIT_" + k] || process.env.GHL_PIT || "";
}

async function rawCall(token, method, path, { query, body, form } = {}) {
  const wait = lastCall + 125 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  const url = new URL(GHL_BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = Array.isArray(data.message) ? data.message.join("; ") : (data.message || data.error || text.slice(0, 200));
    const err = new Error(`GoHighLevel ${r.status}: ${msg}`);
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

async function locationToken(locationId) {
  const cached = locTokens[locationId];
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const agency = baseToken();
  let companyId = process.env.GHL_COMPANY_ID || companyIds[locationId];
  if (!companyId) {
    const l = await rawCall(agency, "GET", `/locations/${locationId}`);
    companyId = companyIds[locationId] = l.location?.companyId || l.companyId;
    if (!companyId) throw new Error("Couldn't find the agency (company) ID for this location. Set GHL_COMPANY_ID.");
  }
  const t = await rawCall(agency, "POST", "/oauth/locationToken", { form: { companyId, locationId } });
  if (!t.access_token) throw new Error("GoHighLevel didn't return a location token.");
  locTokens[locationId] = { token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  return t.access_token;
}

const wrongTokenType = e => (e.status === 401 || e.status === 403) &&
  /authclass|not authorized for this scope|token.*(type|location)|location.*access|agency/i.test(JSON.stringify(e.data || e.message));

export async function ghl(method, path, opts = {}) {
  const token = baseToken();
  if (!token) throw new Error("GHL_PIT is not set on the server.");
  const loc = LOCATION_ID();
  if (tokenMode[loc] === "exchange") return rawCall(await locationToken(loc), method, path, opts);
  try {
    const d = await rawCall(token, method, path, opts);
    tokenMode[loc] ||= "direct";
    return d;
  } catch (e) {
    // an agency token can read some location info but not contacts etc.: on a token-type
    // refusal, switch this location to exchanged location tokens (unless that already failed)
    if (!wrongTokenType(e) || exchangeFailed[loc]) throw e;
    let lt;
    try { lt = await locationToken(loc); }
    catch (e2) {
      exchangeFailed[loc] = e2.message;
      throw new Error(`${e.message}. Tried exchanging the agency token for a location token: ${e2.message}`);
    }
    tokenMode[loc] = "exchange";
    return rawCall(lt, method, path, opts);
  }
}

/** Startup self-test: what this token can do, per location. Logs no secrets. */
export async function selfTest() {
  const out = {};
  for (const [key, id] of Object.entries(locations())) {
    out[key] = await withLocation(key, async () => {
      const r = { locationId: id };
      try { const l = await READS.location(); r.location = l.location?.name || l.name || "ok"; } catch (e) { r.location = "✗ " + e.message; }
      try { const c = await READS["contacts.search"]({ limit: 1 }); r.contacts = `ok (${c.total ?? (c.contacts || []).length} total)`; } catch (e) { r.contacts = "✗ " + e.message; }
      r.tokenMode = tokenMode[id] || "unknown";
      if (exchangeFailed[id]) r.exchange = "✗ " + exchangeFailed[id];
      return r;
    });
  }
  return out;
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

// File storage for always-on hosts (Railway volume): set GLYTCH_DATA_DIR=/data
const dataDir = () => process.env.GLYTCH_DATA_DIR || "";
let fileLoaded = false;
function fileLoad() {
  if (fileLoaded || !dataDir()) return;
  fileLoaded = true;
  try { const j = JSON.parse(fs.readFileSync(path.join(dataDir(), "glytch-store.json"), "utf8")); mem.hash = j.hash || {}; mem.list = j.list || []; } catch {}
}
function fileSave() {
  if (!dataDir()) return;
  fs.mkdirSync(dataDir(), { recursive: true });
  const f = path.join(dataDir(), "glytch-store.json");
  fs.writeFileSync(f + ".tmp", JSON.stringify({ hash: mem.hash, list: mem.list }));
  fs.renameSync(f + ".tmp", f);
}

export const store = {
  async put(p) {
    if (useRedis()) await redis(["HSET", P, p.id, JSON.stringify(p)]);
    else { fileLoad(); mem.hash[p.id] = JSON.stringify(p); fileSave(); }
    return p;
  },
  async get(id) {
    if (!useRedis()) fileLoad();
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
    fileLoad();
    return Object.values(mem.hash).map(v => JSON.parse(v));
  },
  async log(entry) {
    const e = JSON.stringify({ at: new Date().toISOString(), ...entry });
    if (useRedis()) { await redis(["LPUSH", L, e]); await redis(["LTRIM", L, "0", "999"]); }
    else { fileLoad(); mem.list.unshift(e); mem.list.length = Math.min(mem.list.length, 1000); fileSave(); }
  },
  async logs(n = 200) {
    if (!useRedis()) fileLoad();
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
  const location = currentLocationKey();
  const dedupeKey = crypto.createHash("sha1").update(`${location}|${op}|${targetId}|${JSON.stringify(payload)}`).digest("hex").slice(0, 16);
  const existing = (await store.all()).find(x => x.dedupeKey === dedupeKey && x.status === "pending");
  if (existing) return { proposal: existing, duplicate: true };
  // jobs pass the record they just read, saving one GoHighLevel call per proposal
  const before = knownBefore !== undefined ? knownBefore : await def.snapshot({ targetId, payload });
  if (op !== "contact.create" && !before) throw Object.assign(new Error(`Record ${targetId} not found.`), { status: 404 });
  const p = {
    id: "p_" + crypto.randomBytes(6).toString("hex"),
    op, label: def.label, destructive: def.destructive, location,
    targetId, payload, reason, source, dedupeKey,
    before, fingerprint: fingerprint(before),
    status: "pending", createdAt: new Date().toISOString(),
  };
  await store.put(p);
  await store.log({ event: "proposed", id: p.id, op, targetId, source, reason, location });
  return { proposal: p, duplicate: false };
}

export async function decide(id, decision, opts = {}) {
  const p0 = await store.get(id);
  if (!p0) throw Object.assign(new Error("Proposal not found."), { status: 404 });
  return withLocation(p0.location, () => decideIn(id, decision, opts));
}
async function decideIn(id, decision, { confirmText = "", force = false, decidedBy = "admin" } = {}) {
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
