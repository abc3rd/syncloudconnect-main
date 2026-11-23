// GLYTCH User Access Portal — Omega UI, LLC / SynCloud Connect
// One Node service on Railway: logins + roles (Railway Postgres), a Gridstack dashboard,
// a role-gated proxy to the GLYTCH bridge (bridge keys never reach the browser),
// and hosting for the GHL Data Prep Kit at /kit.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const BRIDGE = (process.env.BRIDGE_URL || "").replace(/\/$/, "");
const SECRET = process.env.SESSION_SECRET || "";
const SECURE = process.env.NODE_ENV === "production";
if (!SECRET || SECRET.length < 24) { console.error("SESSION_SECRET must be set (24+ characters)."); process.exit(1); }

// ---------------------------------------------------------------- database
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "off" ? false : (process.env.DATABASE_URL || "").includes("railway.internal") ? false : { rejectUnauthorized: false },
  max: 5,
});
async function migrate() {
  await db.query(`CREATE SCHEMA IF NOT EXISTS portal`);
  await db.query(`CREATE TABLE IF NOT EXISTS portal.users (
    id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL CHECK (role IN ('owner','admin','staff','viewer')),
    pass_hash TEXT NOT NULL, pass_ver INT NOT NULL DEFAULT 1, must_change BOOLEAN NOT NULL DEFAULT false,
    disabled BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_login TIMESTAMPTZ)`);
  await db.query(`CREATE TABLE IF NOT EXISTS portal.layouts (
    user_id INT PRIMARY KEY REFERENCES portal.users(id) ON DELETE CASCADE, layout JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.query(`CREATE TABLE IF NOT EXISTS portal.events (
    id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), user_id INT, event TEXT NOT NULL, detail JSONB)`);
  // owner bootstrap: only when no owner exists; never a "first visitor claims it" sign-up
  const { rows } = await db.query(`SELECT 1 FROM portal.users WHERE role='owner' LIMIT 1`);
  if (!rows.length && process.env.PORTAL_OWNER_EMAIL && process.env.PORTAL_OWNER_PASSWORD) {
    await db.query(`INSERT INTO portal.users (email, name, role, pass_hash, must_change) VALUES ($1,$2,'owner',$3,true)
      ON CONFLICT (email) DO UPDATE SET role='owner'`,
      [process.env.PORTAL_OWNER_EMAIL.toLowerCase(), process.env.PORTAL_OWNER_NAME || "Owner", await hashPw(process.env.PORTAL_OWNER_PASSWORD)]);
    console.log("Owner account created for", process.env.PORTAL_OWNER_EMAIL);
  }
}
const logEvent = (userId, event, detail) => db.query(`INSERT INTO portal.events (user_id, event, detail) VALUES ($1,$2,$3)`, [userId, event, detail || null]).catch(() => {});

// ---------------------------------------------------------------- passwords + sessions
function hashPw(pw) {
  return new Promise((ok, no) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, key) => e ? no(e) : ok(`s1$${salt.toString("base64")}$${key.toString("base64")}`));
  });
}
function checkPw(pw, stored) {
  return new Promise(ok => {
    const [, s, k] = String(stored).split("$");
    if (!s || !k) return ok(false);
    crypto.scrypt(pw, Buffer.from(s, "base64"), 64, { N: 16384, r: 8, p: 1 }, (e, key) => {
      const want = Buffer.from(k, "base64");
      ok(!e && key.length === want.length && crypto.timingSafeEqual(key, want));
    });
  });
}
const tempPassword = () => crypto.randomBytes(9).toString("base64url");
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function makeSession(u) {
  const body = Buffer.from(JSON.stringify({ id: u.id, v: u.pass_ver, exp: Date.now() + 7 * 864e5 })).toString("base64url");
  return `${body}.${sign(body)}`;
}
async function userFrom(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)glytch_s=([^;]+)/);
  if (!m) return null;
  const [body, sig] = m[1].split(".");
  if (!body || !sig || sig.length !== sign(body).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(body)))) return null;
  let s; try { s = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (!s.exp || s.exp < Date.now()) return null;
  const { rows } = await db.query(`SELECT id, email, name, role, pass_ver, must_change, disabled FROM portal.users WHERE id=$1`, [s.id]);
  const u = rows[0];
  if (!u || u.disabled || u.pass_ver !== s.v) return null; // password change / disable ends old sessions
  return u;
}
const cookie = (v, maxAge) => `glytch_s=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? "; Secure" : ""}`;

// ---------------------------------------------------------------- helpers
function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let raw = ""; for await (const c of req) { raw += c; if (raw.length > 1e6) throw Object.assign(new Error("Too large"), { status: 413 }); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error("Bad JSON"), { status: 400 }); }
}
const RANK = { viewer: 1, staff: 2, admin: 3, owner: 4 };
const can = (u, role) => u && RANK[u.role] >= RANK[role];
const tries = new Map(); // login rate limit per IP: 8 attempts / 10 min
function limited(ip) {
  const now = Date.now(), list = (tries.get(ip) || []).filter(t => now - t < 6e5);
  tries.set(ip, list);
  return list.length >= 8;
}
const pub = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, mustChange: u.must_change });

// ---------------------------------------------------------------- bridge proxy (role-gated)
// owner/admin → bridge admin key (can approve); staff → agent key (read, propose, run tasks); viewer → agent key, reads only
async function bridge(req, res, u, sub) {
  if (!BRIDGE) return send(res, 503, { error: "Bridge not configured." });
  const method = req.method;
  const op = sub.split("?")[0];
  const allowed =
    (op === "status") ||
    (op === "read" && method === "GET") ||
    (op === "proposals" && method === "GET") ||
    (op === "proposals" && method === "POST" && can(u, "staff")) ||
    (op === "jobs" && method === "POST" && can(u, "staff")) ||
    (op === "decide" && method === "POST" && can(u, "admin")) ||
    (op === "log" && method === "GET" && can(u, "admin"));
  if (!allowed) return send(res, 403, { error: "Your role can't do that." });
  let body;
  if (method === "POST") {
    body = await readJson(req);
    if (op === "proposals") {
      const tag = it => ({ ...it, source: `portal:${u.email}` });
      body = Array.isArray(body.items) ? { items: body.items.map(tag) } : tag(body);
    }
    if (op === "decide") await logEvent(u.id, "decide", { id: body.id, ids: body.ids, decision: body.decision });
  }
  const key = can(u, "admin") ? process.env.BRIDGE_ADMIN_KEY : process.env.BRIDGE_AGENT_KEY;
  try {
    const r = await fetch(`${BRIDGE}/api/${sub}`, {
      method,
      headers: { "x-glytch-key": key || "", "content-type": "application/json", ...(req.headers["x-glytch-location"] ? { "x-glytch-location": String(req.headers["x-glytch-location"]) } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    res.writeHead(r.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(text);
  } catch (e) { send(res, 502, { error: "Bridge unreachable: " + e.message }); }
}

// ---------------------------------------------------------------- static files
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const STATIC = {
  "/assets/gridstack-all.js": path.join(root, "node_modules/gridstack/dist/gridstack-all.js"),
  "/assets/gridstack.min.css": path.join(root, "node_modules/gridstack/dist/gridstack.min.css"),
};
function serveFile(res, file, cache = "no-cache") {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": cache });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
  const u0 = new URL(req.url, "http://x"), p = u0.pathname;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  try {
    if (p === "/healthz") { res.writeHead(200); return res.end("ok"); }
    if (STATIC[p]) return serveFile(res, STATIC[p], "public, max-age=86400");
    if (p === "/kit" || p === "/kit/") return serveFile(res, path.join(root, "public/kit/index.html"));
    if (p === "/kit/app.html") return serveFile(res, path.join(root, "public/kit/app.html"));
    if (!p.startsWith("/portal-api/")) return serveFile(res, path.join(root, "public/index.html"));

    // mutating API calls must come from the portal page itself
    if (req.method !== "GET" && req.headers["x-portal"] !== "1") return send(res, 403, { error: "Blocked." });
    const api = p.slice("/portal-api/".length);
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

    if (api === "login" && req.method === "POST") {
      if (limited(ip)) return send(res, 429, { error: "Too many tries. Wait 10 minutes." });
      const { email = "", password = "" } = await readJson(req);
      const { rows } = await db.query(`SELECT * FROM portal.users WHERE email=$1`, [String(email).toLowerCase().trim()]);
      const user = rows[0];
      if (!user || user.disabled || !(await checkPw(String(password), user.pass_hash))) {
        tries.get(ip).push(Date.now());
        await logEvent(user?.id || null, "login-failed", { email: String(email).slice(0, 120), ip });
        return send(res, 401, { error: "Wrong email or password." });
      }
      await db.query(`UPDATE portal.users SET last_login=now() WHERE id=$1`, [user.id]);
      await logEvent(user.id, "login", { ip });
      return send(res, 200, { user: pub(user) }, { "Set-Cookie": cookie(makeSession(user), 7 * 86400) });
    }
    if (api === "logout") return send(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0) });

    const u = await userFrom(req);
    if (!u) return send(res, 401, { error: "Please log in." });

    if (api === "me") return send(res, 200, { user: pub(u) });

    if (api === "password" && req.method === "POST") {
      const { current = "", next = "" } = await readJson(req);
      if (String(next).length < 10) return send(res, 400, { error: "Use at least 10 characters." });
      const { rows } = await db.query(`SELECT pass_hash FROM portal.users WHERE id=$1`, [u.id]);
      if (!(await checkPw(String(current), rows[0].pass_hash))) return send(res, 401, { error: "Current password is wrong." });
      const r = await db.query(`UPDATE portal.users SET pass_hash=$1, pass_ver=pass_ver+1, must_change=false WHERE id=$2 RETURNING *`, [await hashPw(String(next)), u.id]);
      await logEvent(u.id, "password-changed");
      return send(res, 200, { user: pub(r.rows[0]) }, { "Set-Cookie": cookie(makeSession(r.rows[0]), 7 * 86400) });
    }
    if (u.must_change) return send(res, 428, { error: "Set a new password first." });

    if (api === "layout") {
      if (req.method === "GET") {
        const { rows } = await db.query(`SELECT layout FROM portal.layouts WHERE user_id=$1`, [u.id]);
        return send(res, 200, { layout: rows[0]?.layout || null });
      }
      if (req.method === "PUT") {
        const { layout } = await readJson(req);
        if (!Array.isArray(layout) || layout.length > 50) return send(res, 400, { error: "Bad layout." });
        const clean = layout.map(w => ({ id: String(w.id).slice(0, 40), x: +w.x | 0, y: +w.y | 0, w: +w.w | 0, h: +w.h | 0 }));
        await db.query(`INSERT INTO portal.layouts (user_id, layout) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET layout=$2, updated_at=now()`, [u.id, JSON.stringify(clean)]);
        return send(res, 200, { ok: true });
      }
      if (req.method === "DELETE") { await db.query(`DELETE FROM portal.layouts WHERE user_id=$1`, [u.id]); return send(res, 200, { ok: true }); }
    }

    if (api === "users") {
      if (!can(u, "admin")) return send(res, 403, { error: "Admins only." });
      if (req.method === "GET") {
        const { rows } = await db.query(`SELECT id, email, name, role, disabled, last_login, created_at FROM portal.users ORDER BY created_at`);
        return send(res, 200, { users: rows });
      }
      if (req.method === "POST") {
        const { email = "", name = "", role = "viewer" } = await readJson(req);
        const e = String(email).toLowerCase().trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return send(res, 400, { error: "Enter a valid email." });
        if (!["admin", "staff", "viewer"].includes(role) || (role === "admin" && u.role !== "owner")) return send(res, 403, { error: "You can't give that role." });
        const temp = tempPassword();
        try {
          const r = await db.query(`INSERT INTO portal.users (email, name, role, pass_hash, must_change) VALUES ($1,$2,$3,$4,true) RETURNING id, email, name, role`, [e, String(name).slice(0, 80), role, await hashPw(temp)]);
          await logEvent(u.id, "user-created", { email: e, role });
          return send(res, 201, { user: r.rows[0], tempPassword: temp });
        } catch (err) { if (err.code === "23505") return send(res, 409, { error: "That email already has an account." }); throw err; }
      }
    }
    const um = api.match(/^users\/(\d+)(\/reset)?$/);
    if (um) {
      if (!can(u, "admin")) return send(res, 403, { error: "Admins only." });
      const id = Number(um[1]);
      const { rows } = await db.query(`SELECT * FROM portal.users WHERE id=$1`, [id]);
      const t = rows[0];
      if (!t) return send(res, 404, { error: "No such user." });
      if (t.role === "owner" || (t.role === "admin" && u.role !== "owner") || t.id === u.id) return send(res, 403, { error: "You can't change that account here." });
      if (um[2] && req.method === "POST") {
        const temp = tempPassword();
        await db.query(`UPDATE portal.users SET pass_hash=$1, pass_ver=pass_ver+1, must_change=true WHERE id=$2`, [await hashPw(temp), id]);
        await logEvent(u.id, "password-reset", { target: t.email });
        return send(res, 200, { tempPassword: temp });
      }
      if (req.method === "PATCH") {
        const b = await readJson(req);
        if (b.role && (!["admin", "staff", "viewer"].includes(b.role) || (b.role === "admin" && u.role !== "owner"))) return send(res, 403, { error: "You can't give that role." });
        const r = await db.query(`UPDATE portal.users SET role=COALESCE($1, role), disabled=COALESCE($2, disabled), pass_ver = pass_ver + CASE WHEN $2 IS TRUE THEN 1 ELSE 0 END WHERE id=$3 RETURNING id, email, name, role, disabled`,
          [b.role || null, typeof b.disabled === "boolean" ? b.disabled : null, id]);
        await logEvent(u.id, "user-updated", { target: t.email, ...b });
        return send(res, 200, { user: r.rows[0] });
      }
    }

    if (api === "events" && can(u, "admin")) {
      const { rows } = await db.query(`SELECT e.at, e.event, e.detail, u.email FROM portal.events e LEFT JOIN portal.users u ON u.id=e.user_id ORDER BY e.id DESC LIMIT 100`);
      return send(res, 200, { events: rows });
    }

    if (api.startsWith("bridge/")) return bridge(req, res, u, api.slice(7) + (u0.search || ""));

    send(res, 404, { error: "Not found." });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong." });
  }
});

migrate().then(() => server.listen(PORT, () => console.log(`GLYTCH portal on :${PORT}; bridge ${BRIDGE ? "connected" : "NOT set"}`)))
  .catch(e => { console.error("Startup failed:", e.message); process.exit(1); });
