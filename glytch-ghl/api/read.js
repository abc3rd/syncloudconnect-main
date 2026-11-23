// GET /api/read?op=contacts.search&query=smith   (admin or agent key) — reads run immediately
import { requireRole, send, READS, handleError } from "./_lib.js";

export default async function handler(req, res) {
  if (!requireRole(req, res, ["admin", "agent"])) return;
  const url = new URL(req.url, "http://x");
  const op = url.searchParams.get("op");
  if (!op || !READS[op]) return send(res, 400, { error: `Unknown read "${op}".`, allowed: Object.keys(READS) });
  try {
    send(res, 200, await READS[op](Object.fromEntries(url.searchParams)));
  } catch (e) { handleError(res, e); }
}
