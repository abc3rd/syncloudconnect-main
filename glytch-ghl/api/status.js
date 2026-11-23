// GET /api/status — what's configured, and (with a key) a live connection test
import { roleOf, send, configStatus, READS } from "./_lib.js";

export default async function handler(req, res) {
  const role = roleOf(req);
  const out = { bridge: "GLYTCH ⇄ GoHighLevel", version: "1.0.0", config: configStatus(), role };
  if (role === "admin" || role === "agent") {
    try { const l = await READS.location(); out.ghl = { ok: true, location: l.location?.name || l.name || "connected" }; }
    catch (e) { out.ghl = { ok: false, error: e.message }; }
  }
  send(res, 200, out);
}
