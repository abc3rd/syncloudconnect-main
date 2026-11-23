// POST /api/decide {id, decision:"approve"|"reject", confirmText?, force?}   ADMIN KEY ONLY
// or   {ids:[...], decision}  for bulk (destructive edits are never bulk-approved)
import { requireRole, send, readBody, decide, store, handleError } from "./_lib.js";

export default async function handler(req, res) {
  if (!requireRole(req, res, ["admin"])) return;
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  try {
    const b = await readBody(req);
    if (Array.isArray(b.ids)) {
      const results = [];
      for (const id of b.ids.slice(0, 100)) {
        const p = await store.get(id);
        if (p?.destructive && b.decision === "approve") { results.push({ id, status: "skipped", reason: "Deletes must be approved one at a time." }); continue; }
        try { const r = await decide(id, b.decision, { decidedBy: "admin" }); results.push({ id, status: r.status }); }
        catch (e) { results.push({ id, status: "error", reason: e.message }); }
      }
      return send(res, 200, { results });
    }
    send(res, 200, { proposal: await decide(b.id, b.decision, { confirmText: b.confirmText, force: !!b.force, decidedBy: "admin" }) });
  } catch (e) { handleError(res, e); }
}
