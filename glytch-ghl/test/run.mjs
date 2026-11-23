// End-to-end tests: bridge + mock GoHighLevel. Run: npm test
process.env.GHL_BASE_URL = "http://127.0.0.1:4010";
process.env.GHL_PIT = "test-pit"; process.env.GHL_LOCATION_ID = "loc1";
process.env.GLYTCH_ADMIN_KEY = "admin-key-123"; process.env.GLYTCH_AGENT_KEY = "agent-key-456"; process.env.CRON_SECRET = "cron-789";
const { startMockGhl } = await import("./mock-ghl.mjs");
const { startBridge } = await import("./serve.mjs");
const { db, server: ghlSrv } = await startMockGhl(4010);
const bridge = await startBridge(4020);
const B = "http://127.0.0.1:4020/api";
const call = async (path, { key, method = "GET", body, auth } = {}) => {
  const r = await fetch(B + path, { method, headers: { ...(key ? { "x-glytch-key": key } : {}), ...(auth ? { authorization: auth } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`); };
const ADMIN = "admin-key-123", AGENT = "agent-key-456";

let r = await call("/status"); t("status works without key, reveals no data", r.status === 200 && !r.json.ghl && r.json.config.ghlToken);
r = await call("/status", { key: AGENT }); t("status with key tests live connection", r.json.ghl?.ok && r.json.ghl.location === "SynCloud Test Location", JSON.stringify(r.json.ghl));
r = await call("/read?op=contacts.search&query=smith"); t("no key → 401", r.status === 401);
r = await call("/read?op=contacts.search&query=smith", { key: "wrong" }); t("wrong key → 401", r.status === 401);
r = await call("/read?op=contacts.search&query=smith", { key: AGENT }); t("agent can read contacts", r.status === 200 && r.json.contacts.length === 2);
r = await call("/read?op=nope", { key: AGENT }); t("unknown read rejected", r.status === 400);

const writesBefore = db.writes.length;
r = await call("/jobs", { key: AGENT, method: "POST", body: { job: "all" } });
t("jobs run (all)", r.status === 200, JSON.stringify(r.json));
console.log("      job summary:", JSON.stringify(r.json.summary));
t("format job found c1 + c4", r.json.summary.format.proposed === 2);
t("duplicate job tagged newer John Smith", r.json.summary.duplicates.proposed === 1);
t("stale-opps flagged only the 40-day-old deal", r.json.summary["stale-opps"].proposed === 1);
t("tag hygiene reports Lead/lead and follow up/follow-up", r.json.summary["tag-hygiene"].report.length === 2);
t("JOBS CHANGED NOTHING IN GOHIGHLEVEL", db.writes.length === writesBefore);

r = await call("/jobs", { key: AGENT, method: "POST", body: { job: "all" } });
t("rerunning jobs doesn't duplicate proposals", r.json.summary.format.proposed === 0 && r.json.summary.format.alreadyPending === 2);

r = await call("/proposals?status=pending", { key: AGENT });
const props = r.json.proposals; t("4 pending proposals", props.length === 4, props.length);
const fmtC1 = props.find(p => p.targetId === "c1" && p.op === "contact.update");
t("c1 fix: phone, email, names", fmtC1?.payload.phone === "+12395550123" && fmtC1.payload.email === "john.smith@gmail.com" && fmtC1.payload.firstName === "John", JSON.stringify(fmtC1?.payload));

r = await call("/decide", { key: AGENT, method: "POST", body: { id: fmtC1.id, decision: "approve" } });
t("AGENT CANNOT APPROVE (403)", r.status === 403);
t("still nothing written", db.writes.length === writesBefore);

r = await call("/decide", { key: ADMIN, method: "POST", body: { id: fmtC1.id, decision: "approve" } });
t("admin approves → executed", r.json.proposal?.status === "done", JSON.stringify(r.json));
t("GoHighLevel got exactly one PUT", db.writes.length === writesBefore + 1 && db.writes.at(-1).m === "PUT");
t("contact c1 is fixed in GoHighLevel", db.contacts.find(c => c.id === "c1").email === "john.smith@gmail.com");

r = await call("/decide", { key: ADMIN, method: "POST", body: { id: fmtC1.id, decision: "approve" } });
t("can't approve twice", r.status === 409);

// stale protection: someone edits c4 in GoHighLevel after the proposal
const fmtC4 = props.find(p => p.targetId === "c4" && p.op === "contact.update");
db.contacts.find(c => c.id === "c4").email = "carla@new.com";
const w = db.writes.length;
r = await call("/decide", { key: ADMIN, method: "POST", body: { id: fmtC4.id, decision: "approve" } });
t("record changed since proposal → held as STALE, not written", r.json.proposal.status === "stale" && db.writes.length === w, r.json.proposal?.status);
r = await call("/decide", { key: ADMIN, method: "POST", body: { id: fmtC4.id, decision: "approve" } });
t("second approval after review → executed", r.json.proposal.status === "done");

// delete needs typed confirmation, and is never bulk-approved
r = await call("/proposals", { key: AGENT, method: "POST", body: { op: "contact.delete", targetId: "c2", reason: "duplicate" } });
const del = r.json.proposals[0]; t("agent can PROPOSE a delete", r.status === 201 && del.destructive);
r = await call("/decide", { key: ADMIN, method: "POST", body: { ids: [del.id], decision: "approve" } });
t("bulk approve skips deletes", r.json.results[0].status === "skipped");
r = await call("/decide", { key: ADMIN, method: "POST", body: { id: del.id, decision: "approve" } });
t("delete without typing DELETE → 428", r.status === 428);
t("c2 still exists", !!db.contacts.find(c => c.id === "c2"));
r = await call("/decide", { key: ADMIN, method: "POST", body: { id: del.id, decision: "reject" } });
t("reject works, nothing deleted", r.json.proposal.status === "rejected" && !!db.contacts.find(c => c.id === "c2"));

// bulk approve the rest
r = await call("/proposals?status=pending", { key: ADMIN });
r = await call("/decide", { key: ADMIN, method: "POST", body: { ids: r.json.proposals.map(p => p.id), decision: "approve" } });
t("bulk approve the 2 tag proposals", r.json.results.length === 2 && r.json.results.every(x => x.status === "done"), JSON.stringify(r.json.results));
t("c2 tagged glytch-duplicate, c3 tagged glytch-follow-up", db.contacts.find(c => c.id === "c2").tags.includes("glytch-duplicate") && db.contacts.find(c => c.id === "c3").tags.includes("glytch-follow-up"));

r = await call("/proposals", { key: AGENT, method: "POST", body: { op: "contact.explode", targetId: "c1" } });
t("unknown edit type rejected", r.status === 400);
r = await call("/proposals", { key: AGENT, method: "POST", body: { op: "contact.update", targetId: "zzz", payload: { firstName: "X" } } });
t("missing record rejected (404)", r.status === 404);

r = await call("/jobs", { auth: "Bearer cron-789" });
t("Vercel cron key can run jobs", r.status === 200);
r = await call("/log", { key: AGENT }); t("agent can't read audit log", r.status === 403);
r = await call("/log", { key: ADMIN }); t("admin sees audit log", r.json.log.some(e => e.event === "executed") && r.json.log.some(e => e.event === "stale"));

console.log(`\n${pass} passed, ${fail} failed`);
bridge.close(); ghlSrv.close();
process.exit(fail ? 1 : 0);
