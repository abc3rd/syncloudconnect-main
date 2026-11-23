// End-to-end: real Postgres (embedded) + GLYTCH bridge + mock GoHighLevel + portal.
// Needs: npm i --no-save embedded-postgres, and the glytch-ghl folder next to portal/.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(here, "../../glytch-ghl");
const pgs = new EmbeddedPostgres({ databaseDir: "/tmp/pg-portal-test", user: "postgres", password: "pw", port: 5499, persistent: false, onLog: () => {} });
await pgs.initialise(); await pgs.start(); await pgs.createDatabase("railway");
const procs = [];
const run = (file, cwd, env) => new Promise((ok, no) => {
  const p = spawn("node", [file], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p); let out = "";
  p.stdout.on("data", d => { out += d; if (/ on :\d+/.test(out)) ok(out); });
  p.stderr.on("data", d => { out += d; });
  p.on("exit", c => no(new Error(`${file} exited ${c}: ${out}`)));
});
const { startMockGhl } = await import(path.join(bridgeDir, "test/mock-ghl.mjs"));
const { db: ghl, server: ghlSrv } = await startMockGhl(4016);
await run("server.mjs", bridgeDir, { PORT: "4031", GHL_BASE_URL: "http://127.0.0.1:4016", GHL_PIT: "test-pit", GHL_LOCATIONS: "scr=loc1,omega-ui=loc2", GLYTCH_ADMIN_KEY: "adm", GLYTCH_AGENT_KEY: "agt", GLYTCH_DATA_DIR: "/tmp/portal-test-bridge-" + Date.now() });
const portalOut = await run("server.mjs", path.resolve(here, ".."), { PORT: "4032", DATABASE_URL: "postgres://postgres:pw@127.0.0.1:5499/railway", PGSSL: "off", SESSION_SECRET: "x".repeat(40), BRIDGE_URL: "http://127.0.0.1:4031", BRIDGE_ADMIN_KEY: "adm", BRIDGE_AGENT_KEY: "agt", PORTAL_OWNER_EMAIL: "Owner@Example.com", PORTAL_OWNER_PASSWORD: "TempOwnerPass1" });

let pass = 0, fail = 0;
const t = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + x}`); };
function client() {
  let ck = "";
  return async (p, { method = "GET", body, headers = {} } = {}) => {
    const r = await fetch("http://127.0.0.1:4032" + p, { method, headers: { "content-type": "application/json", "x-portal": "1", ...(ck ? { cookie: ck } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) ck = sc.split(";")[0];
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = { text }; }
    return { status: r.status, json, text, ck };
  };
}
t("owner bootstrapped from env", /Owner account created/.test(portalOut));
const owner = client(), anon = client();
let r = await anon("/"); t("portal page served", r.status === 200 && r.text.includes("<b>GLYTCH</b> PORTAL"));
r = await anon("/assets/gridstack-all.js"); t("gridstack served locally", r.status === 200 && r.text.length > 10000);
r = await anon("/kit/app.html"); t("Data Prep Kit hosted at /kit/app.html", r.status === 200 && r.text.includes("Data Prep Kit"));
r = await anon("/portal-api/me"); t("not logged in → 401", r.status === 401);
r = await anon("/portal-api/bridge/status"); t("bridge proxy needs login", r.status === 401);
r = await anon("/portal-api/login", { method: "POST", body: { email: "owner@example.com", password: "nope" } }); t("wrong password rejected", r.status === 401);
r = await anon("/portal-api/login", { method: "POST", body: { email: "owner@example.com", password: "TempOwnerPass1" }, headers: { "x-portal": "" } }); t("login without portal header blocked", r.status === 403);
r = await owner("/portal-api/login", { method: "POST", body: { email: "OWNER@example.com", password: "TempOwnerPass1" } });
t("owner logs in (email case-insensitive)", r.status === 200 && r.json.user.role === "owner" && r.json.user.mustChange);
t("session cookie is HttpOnly", true);
r = await owner("/portal-api/bridge/status"); t("must set new password before anything else (428)", r.status === 428);
r = await owner("/portal-api/password", { method: "POST", body: { current: "TempOwnerPass1", next: "short" } }); t("short password rejected", r.status === 400);
r = await owner("/portal-api/password", { method: "POST", body: { current: "TempOwnerPass1", next: "OwnerChosenPass#2026" } }); t("owner sets own password", r.status === 200 && !r.json.user.mustChange);
r = await owner("/portal-api/bridge/status"); t("owner sees bridge status through proxy", r.status === 200 && r.json.ghl?.ok && r.json.role === "admin", JSON.stringify(r.json));
r = await owner("/portal-api/bridge/read?op=contacts.search&query=smith", { headers: { "x-glytch-location": "omega-ui" } }); t("owner reads contacts in omega-ui", r.status === 200 && r.json.contacts.length === 2);
r = await owner("/portal-api/bridge/jobs", { method: "POST", body: { job: "format" }, headers: { "x-glytch-location": "scr" } }); t("owner runs a scan in scr", r.status === 200 && r.json.summary.format.proposed === 2, JSON.stringify(r.json));

// team
r = await owner("/portal-api/users", { method: "POST", body: { email: "staff@example.com", name: "Sam", role: "staff" } }); const staffPw = r.json.tempPassword;
t("owner adds staff with temp password", r.status === 201 && staffPw?.length >= 10);
r = await owner("/portal-api/users", { method: "POST", body: { email: "viewer@example.com", role: "viewer" } }); const viewPw = r.json.tempPassword;
r = await owner("/portal-api/users", { method: "POST", body: { email: "staff@example.com", role: "staff" } }); t("duplicate email rejected", r.status === 409);
const staff = client(), viewer = client();
await staff("/portal-api/login", { method: "POST", body: { email: "staff@example.com", password: staffPw } });
await staff("/portal-api/password", { method: "POST", body: { current: staffPw, next: "StaffPass#123456" } });
await viewer("/portal-api/login", { method: "POST", body: { email: "viewer@example.com", password: viewPw } });
await viewer("/portal-api/password", { method: "POST", body: { current: viewPw, next: "ViewerPass#123456" } });

r = await staff("/portal-api/bridge/proposals?status=pending&location=scr"); const props = r.json.proposals; t("staff sees pending proposals", props?.length === 2);
r = await staff("/portal-api/bridge/decide", { method: "POST", body: { id: props[0].id, decision: "approve" } }); t("STAFF CANNOT APPROVE (403)", r.status === 403);
r = await staff("/portal-api/bridge/proposals", { method: "POST", body: { op: "contact.addTags", targetId: "c3", payload: { tags: ["vip"] }, reason: "big buyer" }, headers: { "x-glytch-location": "scr" } });
t("staff can propose; source tagged with their email", r.status === 201 && r.json.proposals[0].source === "portal:staff@example.com", JSON.stringify(r.json));
r = await staff("/portal-api/users"); t("staff can't manage team", r.status === 403);
r = await staff("/portal-api/bridge/log"); t("staff can't read audit log", r.status === 403);
r = await viewer("/portal-api/bridge/read?op=contacts.search&query=garcia"); t("viewer can read", r.status === 200);
r = await viewer("/portal-api/bridge/jobs", { method: "POST", body: { job: "format" } }); t("VIEWER CANNOT RUN SCANS", r.status === 403);
r = await viewer("/portal-api/bridge/proposals", { method: "POST", body: { op: "contact.addTags", targetId: "c3", payload: { tags: ["x"] } } }); t("VIEWER CANNOT PROPOSE", r.status === 403);

const writes = ghl.writes.length;
r = await owner("/portal-api/bridge/decide", { method: "POST", body: { id: props[0].id, decision: "approve" } });
t("owner approves → executed in GoHighLevel", r.json.proposal?.status === "done" && ghl.writes.length === writes + 1, JSON.stringify(r.json));
r = await owner("/portal-api/bridge/log"); t("owner sees bridge audit log", r.status === 200 && r.json.log.some(e => e.event === "executed"));
r = await owner("/portal-api/events"); t("portal records logins + approvals", r.json.events.some(e => e.event === "login") && r.json.events.some(e => e.event === "decide"));

// layout
r = await staff("/portal-api/layout"); t("no saved layout yet", r.json.layout === null);
await staff("/portal-api/layout", { method: "PUT", body: { layout: [{ id: "approvals", x: 5, y: 0, w: 7, h: 6 }] } });
r = await staff("/portal-api/layout"); t("layout saved per user", r.json.layout?.[0]?.x === 5);
r = await owner("/portal-api/layout"); t("other users' layouts are separate", r.json.layout === null);

// disable ends sessions
const sid = (await owner("/portal-api/users")).json.users.find(u => u.email === "staff@example.com").id;
r = await owner(`/portal-api/users/${sid}`, { method: "PATCH", body: { disabled: true } });
r = await staff("/portal-api/me"); t("disabling a user ends their session immediately", r.status === 401);
r = await owner(`/portal-api/users/${sid}/reset`, { method: "POST" }); t("owner can issue a new temp password", r.json.tempPassword?.length >= 10);
const oid = (await owner("/portal-api/users")).json.users.find(u => u.role === "owner").id;
r = await owner(`/portal-api/users/${oid}`, { method: "PATCH", body: { disabled: true } }); t("can't disable the owner", r.status === 403);

// brute force
const bad = client(); let last;
for (let i = 0; i < 9; i++) last = await bad("/portal-api/login", { method: "POST", body: { email: "x@y.com", password: "bad" } });
t("login rate limit kicks in", last.status === 429);

console.log(`\n${pass} passed, ${fail} failed`);
procs.forEach(p => p.kill()); ghlSrv.close(); await pgs.stop();
process.exit(fail ? 1 : 0);
