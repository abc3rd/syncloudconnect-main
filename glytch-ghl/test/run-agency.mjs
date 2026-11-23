// Agency token + two locations, against the mock GoHighLevel.
process.env.GHL_BASE_URL = "http://127.0.0.1:4013";
process.env.GHL_PIT = "agency-pit";
process.env.GHL_LOCATIONS = "scr=locSCR,omega-ui=locOMEGA";
process.env.GLYTCH_ADMIN_KEY = "a1"; process.env.GLYTCH_AGENT_KEY = "g1";
delete process.env.GHL_LOCATION_ID;
const { startMockGhl } = await import("./mock-ghl.mjs");
const { startBridge } = await import("./serve.mjs");
const lib = await import("../api/_lib.js");
const { db, server: g } = await startMockGhl(4013);
const bridge = await startBridge(4023);
let pass = 0, fail = 0;
const t = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + x}`); };
const call = async (path, { key = "a1", loc, method = "GET", body } = {}) => {
  const r = await fetch("http://127.0.0.1:4023/api" + path, { method, headers: { "x-glytch-key": key, "content-type": "application/json", ...(loc ? { "x-glytch-location": loc } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};

const st = await lib.selfTest();
console.log("      self-test:", JSON.stringify(st));
t("self-test: both locations reach contacts via exchanged token", st.scr.contacts.startsWith("ok") && st["omega-ui"].contacts.startsWith("ok"), JSON.stringify(st));
t("self-test reports exchange mode", st.scr.tokenMode === "exchange" && st["omega-ui"].tokenMode === "exchange");

let r = await call("/status");
t("status lists both locations", JSON.stringify(r.json.config.locations) === '["scr","omega-ui"]', JSON.stringify(r.json.config));
r = await call("/read?op=contacts.search&query=smith", { loc: "omega-ui" });
t("read in omega-ui works", r.status === 200 && r.json.contacts.length === 2, JSON.stringify(r.json));
t("omega-ui call used omega-ui's location token", db.locCalls.at(-1) === "locOMEGA");
r = await call("/read?op=contacts.search&query=garcia", { loc: "scr" });
t("read in scr used scr's location token", r.status === 200 && db.locCalls.at(-1) === "locSCR");

r = await call("/jobs", { loc: "scr", method: "POST", body: { job: "format" } });
t("job runs in scr", r.status === 200 && r.json.summary.format.proposed === 2, JSON.stringify(r.json));
r = await call("/proposals?status=pending&location=scr");
const p = r.json.proposals[0];
t("proposals are labelled with their location", r.json.proposals.length === 2 && p.location === "scr");
r = await call("/proposals?status=pending&location=omega-ui");
t("omega-ui queue is separate", r.json.proposals.length === 0);
const before = db.locCalls.length;
r = await call("/decide", { method: "POST", body: { id: p.id, decision: "approve" } });  // no location header on purpose
t("approval runs in the proposal's own location", r.json.proposal.status === "done" && db.locCalls.slice(before).every(x => x === "locSCR"), JSON.stringify(db.locCalls.slice(before)));
const exchanges = db.agencyCalls;
await call("/read?op=tags", { loc: "scr" });
t("location token is cached (no new exchange)", db.agencyCalls === exchanges);

console.log(`\n${pass} passed, ${fail} failed`);
bridge.close(); g.close(); process.exit(fail ? 1 : 0);
