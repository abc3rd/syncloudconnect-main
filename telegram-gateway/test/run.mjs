// Gateway end-to-end: fake Telegram + fake Open WebUI + real GLYTCH bridge (mock GoHighLevel).
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(here, "../../glytch-ghl");

// ---- fake Telegram: per-token update queues, captured sends
const tgState = { queues: {}, sent: [], ids: 0 };
const tgSrv = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c; const j = b ? JSON.parse(b) : {};
  const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/); const token = m[1], method = m[2];
  const ok = r => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result: r })); };
  if (token === "BADTOKEN") { res.writeHead(401); return res.end(JSON.stringify({ ok: false, description: "Unauthorized" })); }
  if (method === "getMe") return ok({ id: 1, username: token.split(":")[0] + "_bot" });
  if (method === "getUpdates") {
    const q = (tgState.queues[token] ||= []);
    const pending = q.filter(u => u.update_id >= (j.offset || 0));
    if (pending.length) return ok(pending);
    return setTimeout(() => ok([]), 150);
  }
  if (method === "sendMessage") { tgState.sent.push({ token, chat: j.chat_id, text: j.text }); return ok({ message_id: ++tgState.ids }); }
  if (method === "sendChatAction") return ok(true);
  ok({});
});
await new Promise(r => tgSrv.listen(4041, r));
let uid = 1000;
const say = (token, from, text, chat = from) => (tgState.queues[token] ||= []).push({ update_id: ++uid, message: { message_id: uid, chat: { id: chat }, from: { id: from, first_name: "T" + from }, text } });
const lastTo = (token, chat) => tgState.sent.filter(s => s.token === token && s.chat === chat).at(-1)?.text || "";
const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitReply(token, chat, n0) { for (let i = 0; i < 60; i++) { const n = tgState.sent.filter(s => s.token === token && s.chat === chat).length; if (n > n0) return lastTo(token, chat); await wait(100); } return "(timeout)"; }
const count = (token, chat) => tgState.sent.filter(s => s.token === token && s.chat === chat).length;

// ---- fake Open WebUI
const ow = { users: [], models: {}, signup: true, chats: [] , down: false};
const owSrv = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c; const j = b ? JSON.parse(b) : {};
  const send = (s, x) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(x)); };
  const u = new URL(req.url, "http://x"); const auth = req.headers.authorization || "";
  if (u.pathname === "/api/v1/auths/signup") { if (ow.users.length && !ow.signup) return send(403, { detail: "signup disabled" }); ow.users.push(j); return send(200, { token: "jwt-" + j.email }); }
  if (u.pathname === "/api/v1/auths/signin") { const x = ow.users.find(x => x.email === j.email && x.password === j.password); return x ? send(200, { token: "jwt-" + j.email }) : send(400, { detail: "bad creds" }); }
  if (!auth.startsWith("Bearer jwt-")) return send(401, { detail: "unauth" });
  if (u.pathname === "/api/models") return send(200, { data: [{ id: "gemini-2.5-flash" }, { id: "claude-sonnet-4-5" }, ...Object.keys(ow.models).map(id => ({ id }))] });
  if (u.pathname === "/api/v1/models/model") return ow.models[u.searchParams.get("id")] ? send(200, ow.models[u.searchParams.get("id")]) : send(404, { detail: "nf" });
  if (u.pathname === "/api/v1/models/create" || u.pathname === "/api/v1/models/model/update") { ow.models[j.id] = j; return send(200, j); }
  if (u.pathname === "/api/v1/auths/admin/config") { if (req.method === "GET") return send(200, { ENABLE_SIGNUP: ow.signup, DEFAULT_USER_ROLE: "pending" }); ow.signup = j.ENABLE_SIGNUP; return send(200, j); }
  if (u.pathname === "/api/chat/completions") {
    if (ow.down) return send(500, { detail: "down" });
    ow.chats.push(j);
    const userMsgs = j.messages.filter(m => m.role === "user").map(m => m.content);
    return send(200, { choices: [{ message: { content: `[${j.model}] heard ${userMsgs.length}: ${userMsgs.at(-1)}` } }] });
  }
  send(404, { detail: "no route " + u.pathname });
});
await new Promise(r => owSrv.listen(4042, r));

// ---- real bridge on mock GHL
const { startMockGhl } = await import(path.join(bridgeDir, "test/mock-ghl.mjs"));
const { server: ghlSrv } = await startMockGhl(4043);
const procs = [];
const run = (cwd, env, ready) => new Promise((ok, no) => {
  const p = spawn("node", ["server.mjs"], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }); procs.push(p); let out = "";
  const on = d => { out += d; if (ready.test(out)) ok(() => out); };
  p.stdout.on("data", on); p.stderr.on("data", on); p.on("exit", c => no(new Error("exit " + c + ": " + out)));
});
await run(bridgeDir, { PORT: "4044", GHL_BASE_URL: "http://127.0.0.1:4043", GHL_PIT: "test-pit", GHL_LOCATIONS: "scr=loc1,omega-ui=loc2", GLYTCH_ADMIN_KEY: "adm", GLYTCH_AGENT_KEY: "agt", GLYTCH_DATA_DIR: "/tmp/gw-bridge-" + Date.now() }, / on :\d+/);
const dataDir = "/tmp/gw-data-" + Date.now();
const gwOut = await run(path.resolve(here, ".."), {
  PORT: "4045", TELEGRAM_API_BASE: "http://127.0.0.1:4041", OPENWEBUI_URL: "http://127.0.0.1:4042", BRIDGE_URL: "http://127.0.0.1:4044", BRIDGE_AGENT_KEY: "agt", DATA_DIR: dataDir,
  OWUI_ADMIN_EMAIL: "owner@example.com", OWUI_ADMIN_PASSWORD: "pw-123456789",
  COWBOY_BOT_TOKEN: "cowboy:AAA", COWBOY_PAIR_CODE: "COW-1111", GLYTCH_BOT_TOKEN: "glytch:BBB", GLYTCH_PAIR_CODE: "GLY-2222", PABLO_BOT_TOKEN: "pablo:CCC", PABLO_PAIR_CODE: "PAB-3333",
}, /pablo\] @pablo_bot online/);

let pass = 0, fail = 0;
const t = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  → " + x}`); };
const C = "cowboy:AAA", G = "glytch:BBB", P = "pablo:CCC";

t("Open WebUI admin created on first boot", ow.users.length === 1 && ow.users[0].email === "owner@example.com");
t("three personas created in Open WebUI", ["cowboy", "glytch", "pablo"].every(id => ow.models[id]?.params?.system?.length > 100));
t("personas use Claude when available", ow.models.cowboy.base_model_id === "claude-sonnet-4-5", ow.models.cowboy?.base_model_id);
t("Open WebUI public sign-up turned off", ow.signup === false);
t("all three bots online", /cowboy\] @cowboy_bot online/.test(gwOut()) && /glytch\] @glytch_bot online/.test(gwOut()));

let n = count(C, 501); say(C, 501, "/start"); let r = await waitReply(C, 501, n);
t("stranger gets private notice + their ID", /private/.test(r) && /501/.test(r), r);
n = count(C, 501); say(C, 501, "do you have hay?"); r = await waitReply(C, 501, n);
t("stranger can't chat before pairing", /private/.test(r) && ow.chats.length === 0, r);
n = count(C, 501); say(C, 501, "/pair WRONG-00"); r = await waitReply(C, 501, n);
t("wrong pairing code refused", /didn't work/.test(r), r);
n = count(C, 501); say(C, 501, "/pair COW-1111"); r = await waitReply(C, 501, n);
t("right code pairs the user", /Connected/.test(r), r);
n = count(C, 501); say(C, 501, "do you have hay?"); r = await waitReply(C, 501, n);
t("paired user chats with Cowboy persona", r.startsWith("[cowboy]"), r);
n = count(C, 501); say(C, 501, "and pine shavings?"); r = await waitReply(C, 501, n);
t("conversation keeps history", /heard 2/.test(r), r);

// sovereignty: pairing on Cowboy does not open Pablo
n = count(P, 501); say(P, 501, "show me margins"); r = await waitReply(P, 501, n);
t("SOVEREIGN: Cowboy pairing does not unlock Pablo", /private/.test(r), r);
n = count(P, 501); say(P, 501, "/pair COW-1111"); r = await waitReply(P, 501, n);
t("SOVEREIGN: Cowboy's code doesn't work on Pablo", /didn't work/.test(r), r);
n = count(P, 501); say(P, 501, "/pair PAB-3333"); await waitReply(P, 501, n);
n = count(P, 501); say(P, 501, "what's on my list today"); r = await waitReply(P, 501, n);
t("Pablo answers as Pablo with its own fresh history", r.startsWith("[pablo]") && /heard 1/.test(r), r);
const fCow = JSON.parse(fs.readFileSync(path.join(dataDir, "bot-cowboy.json"))), fPab = JSON.parse(fs.readFileSync(path.join(dataDir, "bot-pablo.json")));
t("SOVEREIGN: separate state files, Cowboy history not in Pablo's", JSON.stringify(fCow).includes("pine shavings") && !JSON.stringify(fPab).includes("pine shavings"));

// GLYTCH bridge commands
n = count(G, 700); say(G, 700, "/pair GLY-2222"); r = await waitReply(G, 700, n);
t("GLYTCH pairing lists commands", /\/pending/.test(r), r);
n = count(G, 700); say(G, 700, "/loc scr"); r = await waitReply(G, 700, n); t("GLYTCH switches sub-account", /scr/.test(r), r);
n = count(G, 700); say(G, 700, "/contacts smith"); r = await waitReply(G, 700, n);
t("GLYTCH reads GoHighLevel contacts live", /Smith/i.test(r), r);
n = count(G, 700); say(G, 700, "/scan format"); r = await waitReply(G, 700, n);
t("GLYTCH runs a scan (propose only)", /proposed 2/.test(r) && /Portal/.test(r), r);
n = count(G, 700); say(G, 700, "/pending"); r = await waitReply(G, 700, n);
t("GLYTCH lists pending approvals", /2 waiting/.test(r), r);
n = count(G, 700); say(G, 700, "/reset"); r = await waitReply(G, 700, n); t("/reset clears history", /Fresh start/.test(r));

// fallback when Open WebUI fails and no direct keys: graceful message
ow.down = true;
n = count(C, 501); say(C, 501, "hello?"); r = await waitReply(C, 501, n);
t("AI outage → friendly message, no crash", /can't reach my AI/.test(r), r);
ow.down = false;
n = count(C, 501); say(C, 501, "back?"); r = await waitReply(C, 501, n); t("recovers after outage", r.startsWith("[cowboy]"), r);

// long replies split under Telegram's 4096 limit
n = count(C, 501); say(C, 501, "x".repeat(6000)); await waitReply(C, 501, n); await wait(300);
const longParts = tgState.sent.filter(s => s.token === C && s.chat === 501).slice(n);
t("long reply split into Telegram-sized parts", longParts.length >= 2 && longParts.every(p => p.text.length <= 4096), longParts.map(p => p.text.length).join(","));

// restart keeps pairings
procs[1].kill(); await wait(300);
const gw2 = await run(path.resolve(here, ".."), { PORT: "4046", TELEGRAM_API_BASE: "http://127.0.0.1:4041", OPENWEBUI_URL: "http://127.0.0.1:4042", BRIDGE_URL: "http://127.0.0.1:4044", BRIDGE_AGENT_KEY: "agt", DATA_DIR: dataDir, OWUI_ADMIN_EMAIL: "owner@example.com", OWUI_ADMIN_PASSWORD: "pw-123456789", COWBOY_BOT_TOKEN: "cowboy:AAA", COWBOY_PAIR_CODE: "COW-1111" }, /cowboy\] @cowboy_bot online/);
n = count(C, 501); say(C, 501, "still there?"); r = await waitReply(C, 501, n);
t("pairing and history survive a restart", r.startsWith("[cowboy]"), r);
t("restart reuses the admin account (no second sign-up)", ow.users.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
procs.forEach(p => p.kill()); tgSrv.close(); owSrv.close(); ghlSrv.close();
process.exit(fail ? 1 : 0);
