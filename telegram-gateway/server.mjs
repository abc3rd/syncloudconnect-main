// Telegram gateway for Cowboy, GLYTCH and Pablo — Omega UI, LLC / SynCloud Connect
// One always-on service, three sovereign bots (long polling, no webhooks needed).
// Brain: Open WebUI (personas, future Ollama); falls back to Claude or Gemini directly.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PERSONAS } from "./personas.mjs";
import { SITES, auditSites, summarize } from "./sites.mjs";

const TG = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
const OWUI = (process.env.OPENWEBUI_URL || "").replace(/\/$/, "");
const BRIDGE = (process.env.BRIDGE_URL || "").replace(/\/$/, "");
const DATA = process.env.DATA_DIR || "/data";
const HISTORY_TURNS = Number(process.env.HISTORY_TURNS) || 12;
const PREFS = (process.env.BASE_MODEL_PREFERENCE || "claude-sonnet,claude,gemini.*pro,gemini.*flash,gemini").split(",").map(s => s.trim()).filter(Boolean);
const log = (...a) => console.log(new Date().toISOString(), ...a);
fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- per-bot sovereign state (one file each)
function stateFile(key) { return path.join(DATA, `bot-${key}.json`); }
function loadState(key) {
  try { return JSON.parse(fs.readFileSync(stateFile(key), "utf8")); } catch { return { allowed: [], chats: {}, offset: 0 }; }
}
function saveState(key, s) {
  const f = stateFile(key);
  fs.writeFileSync(f + ".tmp", JSON.stringify(s));
  fs.renameSync(f + ".tmp", f);
}

// ---------------------------------------------------------------- Telegram
async function tg(token, method, body, timeoutMs = 40000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${TG}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
    return j.result;
  } finally { clearTimeout(t); }
}
async function reply(token, chatId, text) {
  const parts = [];
  let s = String(text || "(no reply)");
  while (s.length > 4000) { let cut = s.lastIndexOf("\n", 4000); if (cut < 2000) cut = 4000; parts.push(s.slice(0, cut)); s = s.slice(cut); }
  parts.push(s);
  for (const p of parts) await tg(token, "sendMessage", { chat_id: chatId, text: p, disable_web_page_preview: true });
}

// ---------------------------------------------------------------- brain: Open WebUI, then direct providers
let owuiToken = null, owuiModels = null;
async function owui(method, p, body, retry = true) {
  if (!owuiToken) await owuiSignin();
  const r = await fetch(OWUI + p, { method, headers: { authorization: `Bearer ${owuiToken}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && retry) { owuiToken = null; return owui(method, p, body, false); }
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw Object.assign(new Error(`Open WebUI ${r.status}: ${(j.detail || j.error?.message || text).toString().slice(0, 200)}`), { status: r.status });
  return j;
}
async function owuiSignin() {
  const email = process.env.OWUI_ADMIN_EMAIL, password = process.env.OWUI_ADMIN_PASSWORD;
  if (!OWUI || !email || !password) throw new Error("Open WebUI not configured.");
  const post = (p, b) => fetch(OWUI + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  let r = await post("/api/v1/auths/signin", { email, password });
  if (r.status !== 200) {
    // first start: create the admin account (the instance has no public address until this is done)
    const s = await post("/api/v1/auths/signup", { name: process.env.OWUI_ADMIN_NAME || "Owner", email, password });
    if (s.ok) log("Open WebUI admin account created for", email);
    r = await post("/api/v1/auths/signin", { email, password });
  }
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error("Open WebUI sign-in failed: " + (j.detail || r.status));
  owuiToken = j.token;
}
function pickBase(ids, persona) {
  const forced = process.env[`${persona.env}_MODEL`];
  if (forced && ids.includes(forced)) return forced;
  const personaIds = Object.values(PERSONAS).map(p => p.modelId);
  const cands = ids.filter(id => !personaIds.includes(id));
  for (const pref of PREFS) { const re = new RegExp(pref, "i"); const hit = cands.find(id => re.test(id)); if (hit) return hit; }
  return cands[0] || null;
}
async function bootstrapOpenWebUI() {
  if (!OWUI) return { ok: false, reason: "OPENWEBUI_URL not set" };
  await owuiSignin();
  const list = await owui("GET", "/api/models");
  const ids = (list.data || []).map(m => m.id);
  const out = {};
  for (const [key, p] of Object.entries(PERSONAS)) {
    const base = pickBase(ids, p);
    if (!base) { out[key] = "waiting for a Claude/Gemini connection"; continue; }
    const body = { id: p.modelId, name: p.name, base_model_id: base, meta: { description: p.description }, params: { system: p.system }, access_control: {} };
    try {
      let exists = false;
      try { await owui("GET", `/api/v1/models/model?id=${encodeURIComponent(p.modelId)}`); exists = true; } catch {}
      if (exists) await owui("POST", `/api/v1/models/model/update?id=${encodeURIComponent(p.modelId)}`, body);
      else await owui("POST", "/api/v1/models/create", body);
      out[key] = `persona on ${base}`;
    } catch (e) { out[key] = "persona setup failed: " + e.message; }
  }
  owuiModels = ids;
  // lock sign-ups once the owner exists
  try {
    const cfg = await owui("GET", "/api/v1/auths/admin/config");
    if (cfg.ENABLE_SIGNUP) { await owui("POST", "/api/v1/auths/admin/config", { ...cfg, ENABLE_SIGNUP: false }); log("Open WebUI public sign-up disabled"); }
  } catch (e) { log("Could not change Open WebUI sign-up setting:", e.message); }
  return { ok: true, models: ids.length, personas: out };
}

async function askOpenWebUI(persona, messages) {
  const j = await owui("POST", "/api/chat/completions", { model: persona.modelId, messages, stream: false });
  const t = j.choices?.[0]?.message?.content;
  if (!t) throw new Error("Open WebUI returned no text");
  return t;
}
async function askClaude(persona, messages) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error("no Claude key");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL || "claude-sonnet-4-5", max_tokens: 1024, system: persona.system, messages: messages.filter(m => m.role !== "system") }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Claude: " + (j.error?.message || r.status));
  return (j.content || []).map(c => c.text || "").join("").trim();
}
async function askGemini(persona, messages) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error("no Gemini key");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: persona.system }] },
      contents: messages.filter(m => m.role !== "system").map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })) }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Gemini: " + (j.error?.message || r.status));
  return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
}
async function think(persona, history) {
  const messages = [{ role: "system", content: persona.system }, ...history];
  const errors = [];
  for (const [name, fn] of [["Open WebUI", askOpenWebUI], ["Claude", askClaude], ["Gemini", askGemini]]) {
    if (name === "Open WebUI" && !OWUI) continue;
    try { return await fn(persona, messages); } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  throw new Error(errors.join(" | ") || "No AI connected yet");
}

// ---------------------------------------------------------------- GLYTCH bridge commands (agent key: read + propose only)
async function bridge(p, opts = {}) {
  if (!BRIDGE) throw new Error("Bridge not configured.");
  const r = await fetch(`${BRIDGE}/api/${p}`, { method: opts.method || "GET", headers: { "x-glytch-key": process.env.BRIDGE_AGENT_KEY || "", "content-type": "application/json", ...(opts.loc ? { "x-glytch-location": opts.loc } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Bridge ${r.status}`);
  return j;
}
const nameOf = c => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.contactName || c.email || c.phone || c.id;
// ---------------------------------------------------------------- site inventory + uptime audit
const AUDIT_FILE = path.join(DATA, "site-audit.json");
let lastAudit = (() => { try { return JSON.parse(fs.readFileSync(AUDIT_FILE, "utf8")); } catch { return null; } })();
async function runAudit() {
  const a = await auditSites();
  lastAudit = a; fs.writeFileSync(AUDIT_FILE, JSON.stringify(a));
  log("SITE_AUDIT summary", JSON.stringify(summarize(a)));
  for (const r of a.results) log(`SITE_AUDIT ${r.verdict} ${r.status} ${r.ms ?? ""}ms ${r.url}${r.final !== r.url ? " -> " + r.final : ""}${r.error ? " err=" + r.error : ""} | ${r.title || ""}`);
  return a;
}
function sitesText(arg) {
  const q = (arg || "").toLowerCase();
  const list = SITES.filter(s => !q || s.brand.toLowerCase().includes(q) || s.host.includes(q));
  if (!list.length) return `No sites match "${arg}". Brands: ${[...new Set(SITES.map(s => s.brand))].join(", ")}`;
  const byUrl = Object.fromEntries((lastAudit?.results || []).map(r => [r.url, r.verdict]));
  const mark = { ok: "✅", redirects: "↪️", broken: "❌", down: "⛔" };
  return `${list.length} pages${q ? ` for "${arg}"` : ""}:\n` + list.slice(0, 60).map(s => `${mark[byUrl[s.url]] || "•"} ${s.url}`).join("\n") + (list.length > 60 ? `\n…and ${list.length - 60} more` : "");
}
function auditText(a) {
  if (!a) return "No audit yet. Send /audit run.";
  const c = summarize(a); const bad = a.results.filter(r => r.verdict === "broken" || r.verdict === "down");
  return `Site audit ${a.at.slice(0, 16).replace("T", " ")} UTC: ✅ ${c.ok} ok · ↪️ ${c.redirects} redirect · ❌ ${c.broken} broken · ⛔ ${c.down} down` + (bad.length ? "\nNeeds attention:\n" + bad.slice(0, 40).map(r => `• ${r.url} (${r.error || r.status})`).join("\n") : "\nEverything answers.");
}

async function glytchCommand(cmd, arg, chatState) {
  const loc = chatState.loc || "";
  if (cmd === "/sites") return sitesText(arg);
  if (cmd === "/audit") return auditText(arg === "run" ? await runAudit() : lastAudit);
  if (cmd === "/loc") {
    const s = await bridge("status");
    const locs = s.config?.locations || [];
    if (!arg) return `Sub-accounts: ${locs.join(", ") || "none"}. Current: ${loc || s.config?.currentLocation}. Switch with /loc <name>.`;
    if (!locs.includes(arg)) return `Unknown sub-account "${arg}". Options: ${locs.join(", ")}`;
    chatState.loc = arg; return `Now working in ${arg}.`;
  }
  if (cmd === "/pending") {
    const j = await bridge(`proposals?status=pending${loc ? "&location=" + encodeURIComponent(loc) : ""}`);
    const list = j.proposals || [];
    if (!list.length) return "Nothing waiting for approval.";
    return `${list.length} waiting for approval (approve in the GLYTCH Portal):\n` + list.slice(0, 10).map(p => `• ${p.label}: ${nameOf(p.before || {}) || p.targetId}${p.reason ? " — " + p.reason.slice(0, 90) : ""}`).join("\n");
  }
  if (cmd === "/contacts") {
    const j = await bridge(`read?op=contacts.search&limit=10&query=${encodeURIComponent(arg || "")}`, { loc });
    const list = j.contacts || [];
    return list.length ? list.map(c => `• ${nameOf(c)} ${c.phone || ""} ${c.email || ""}`.trim()).join("\n") : "No contacts found.";
  }
  if (cmd === "/scan") {
    const job = arg || "format";
    const j = await bridge("jobs", { method: "POST", body: { job }, loc });
    return Object.entries(j.summary || {}).map(([k, v]) => v.report ? `${k}: ${v.report.length ? v.report.join("; ") : "all clean"}` : `${k}: found ${v.found}, proposed ${v.proposed}`).join("\n") + "\nNothing changed yet. Approve in the GLYTCH Portal.";
  }
  return null;
}

// ---------------------------------------------------------------- bot loop
const bots = [];
for (const [key, persona] of Object.entries(PERSONAS)) {
  const token = process.env[`${persona.env}_BOT_TOKEN`];
  if (token) bots.push({ key, persona, token, pair: process.env[`${persona.env}_PAIR_CODE`] || "", status: "starting" });
}

async function handle(bot, msg) {
  const st = bot.state;
  const chatId = msg.chat.id, uid = String(msg.from?.id || ""), text = (msg.text || msg.caption || "").trim();
  if (!text) return reply(bot.token, chatId, "I can read text messages for now.");
  const [cmd0, ...rest] = text.split(/\s+/); const cmd = cmd0.toLowerCase().replace(/@.*$/, ""); const arg = rest.join(" ").trim();
  const allowed = st.allowed.includes(uid) || process.env[`${bot.persona.env}_PUBLIC`] === "true";

  if (cmd === "/start" && !allowed) return reply(bot.token, chatId, `Hi, I'm ${bot.persona.name}. This assistant is private. Send /pair <code> to connect.\nYour Telegram ID: ${uid}`);
  if (cmd === "/pair") {
    if (st.allowed.includes(uid)) return reply(bot.token, chatId, "You're already connected.");
    const ok = bot.pair && arg && arg.length === bot.pair.length && crypto.timingSafeEqual(Buffer.from(arg), Buffer.from(bot.pair));
    st.pairFails = st.pairFails || {};
    if (!ok) {
      st.pairFails[uid] = (st.pairFails[uid] || 0) + 1; saveState(bot.key, st);
      log(`[${bot.key}] failed pairing from ${uid}`);
      return reply(bot.token, chatId, st.pairFails[uid] >= 5 ? "Too many wrong codes." : "That code didn't work.");
    }
    if ((st.pairFails[uid] || 0) >= 5) return reply(bot.token, chatId, "Too many wrong codes.");
    st.allowed.push(uid); saveState(bot.key, st);
    log(`[${bot.key}] paired user ${uid} (${msg.from?.username || msg.from?.first_name || ""})`);
    return reply(bot.token, chatId, `Connected. I'm ${bot.persona.name}. Ask me anything.${bot.key === "glytch" ? "\nCommands: /sites [brand], /audit [run], /pending, /contacts <search>, /scan [format|duplicates|stale-opps|tag-hygiene], /loc [scr|omega-ui], /reset" : "\n/reset starts a fresh conversation."}`);
  }
  if (!allowed) return reply(bot.token, chatId, "This assistant is private. Send /pair <code> to connect.");

  const chatState = (st.chats[chatId] ||= { history: [] });
  if (cmd === "/reset") { chatState.history = []; saveState(bot.key, st); return reply(bot.token, chatId, "Fresh start. What do you need?"); }
  if (cmd === "/whoami") return reply(bot.token, chatId, `${bot.persona.name} · your Telegram ID ${uid}`);
  if (bot.key === "glytch" && cmd.startsWith("/")) {
    try { const r = await glytchCommand(cmd, arg, chatState); if (r !== null) { saveState(bot.key, st); return reply(bot.token, chatId, r); } }
    catch (e) { return reply(bot.token, chatId, "Bridge error: " + e.message); }
  }

  tg(bot.token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  chatState.history.push({ role: "user", content: text.slice(0, 8000) });
  chatState.history = chatState.history.slice(-HISTORY_TURNS * 2);
  let answer;
  try { answer = await think(bot.persona, chatState.history); }
  catch (e) { log(`[${bot.key}] AI error:`, e.message); chatState.history.pop(); return reply(bot.token, chatId, "I can't reach my AI right now. Try again in a minute."); }
  chatState.history.push({ role: "assistant", content: answer });
  saveState(bot.key, st);
  return reply(bot.token, chatId, answer);
}

async function runBot(bot) {
  bot.state = loadState(bot.key);
  try { const me = await tg(bot.token, "getMe", {}); bot.username = me.username; bot.status = "running"; log(`[${bot.key}] @${me.username} online`); }
  catch (e) { bot.status = "bad token: " + e.message; log(`[${bot.key}] ${bot.status}`); return; }
  for (;;) {
    try {
      const updates = await tg(bot.token, "getUpdates", { offset: bot.state.offset, timeout: 25, allowed_updates: ["message"] }, 35000);
      for (const u of updates) {
        bot.state.offset = u.update_id + 1; saveState(bot.key, bot.state);
        if (u.message) await handle(bot, u.message).catch(e => log(`[${bot.key}] handler error:`, e.message));
      }
    } catch (e) { if (!/abort/i.test(e.message)) { log(`[${bot.key}] poll error:`, e.message); await new Promise(r => setTimeout(r, 5000)); } }
  }
}

// ---------------------------------------------------------------- health + startup
let boot = { ok: false, reason: "not run" };
http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ gateway: "GLYTCH Telegram gateway", bots: bots.map(b => ({ bot: b.key, username: b.username, status: b.status })), openwebui: boot }));
}).listen(Number(process.env.PORT) || 3000, async () => {
  log(`Telegram gateway on :${process.env.PORT || 3000}; bots configured: ${bots.map(b => b.key).join(", ") || "none yet (add *_BOT_TOKEN variables)"}`);
  if (OWUI) {
    for (let i = 0; i < 30; i++) {
      try { boot = await bootstrapOpenWebUI(); log("Open WebUI bootstrap:", JSON.stringify(boot)); break; }
      catch (e) { boot = { ok: false, reason: e.message }; await new Promise(r => setTimeout(r, 10000)); }
    }
    if (!boot.ok) log("Open WebUI bootstrap failed:", boot.reason);
  }
  if (process.env.SELFTEST_ONLY === "1") return;
  if (process.env.SITE_AUDIT !== "off") {
    setTimeout(() => runAudit().catch(e => log("SITE_AUDIT failed:", e.message)), 15000);
    setInterval(() => runAudit().catch(e => log("SITE_AUDIT failed:", e.message)), 24 * 3600 * 1000);
  }
  bots.forEach(b => runBot(b));
});
