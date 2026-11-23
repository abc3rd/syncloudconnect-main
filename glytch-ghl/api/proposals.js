// GET  /api/proposals?status=pending      list (admin or agent)
// POST /api/proposals {op,targetId,payload,reason,source}   propose an edit (admin or agent) — nothing runs yet
import { requireRole, send, readBody, store, createProposal, EDITS, handleError } from "./_lib.js";

export default async function handler(req, res) {
  const role = requireRole(req, res, ["admin", "agent"]);
  if (!role) return;
  try {
    if (req.method === "GET") {
      const status = new URL(req.url, "http://x").searchParams.get("status");
      let list = await store.all();
      if (status) list = list.filter(p => p.status === status);
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return send(res, 200, { proposals: list, edits: Object.fromEntries(Object.entries(EDITS).map(([k, v]) => [k, { label: v.label, destructive: v.destructive }])) });
    }
    if (req.method === "POST") {
      const b = await readBody(req);
      const items = Array.isArray(b.items) ? b.items : [b];
      const out = [];
      for (const it of items.slice(0, 200)) out.push(await createProposal({ ...it, source: it.source || role }));
      return send(res, 201, { created: out.filter(x => !x.duplicate).length, duplicates: out.filter(x => x.duplicate).length, proposals: out.map(x => x.proposal) });
    }
    send(res, 405, { error: "Use GET or POST." });
  } catch (e) { handleError(res, e); }
}
