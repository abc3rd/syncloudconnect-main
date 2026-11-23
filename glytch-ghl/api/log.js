// GET /api/log — audit trail (admin only)
import { requireRole, send, store, handleError } from "./_lib.js";
export default async function handler(req, res) {
  if (!requireRole(req, res, ["admin"])) return;
  try { send(res, 200, { log: await store.logs(300) }); } catch (e) { handleError(res, e); }
}
