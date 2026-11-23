// GLYTCH autonomous jobs — they READ GoHighLevel and PROPOSE fixes. They never edit anything.
// GET  /api/jobs                      (Vercel cron, Bearer CRON_SECRET) runs every job
// POST /api/jobs {job, maxPages, staleDays, maxProposals}   (admin or agent) runs one job or "all"
import { requireRole, send, readBody, READS, createProposal, store, handleError } from "./_lib.js";

const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const EMAIL_TYPOS = { "gmial.com":"gmail.com","gmai.com":"gmail.com","gmal.com":"gmail.com","gamil.com":"gmail.com","gmail.co":"gmail.com","gmail.con":"gmail.com","gnail.com":"gmail.com","hotmial.com":"hotmail.com","hotmal.com":"hotmail.com","hotmail.con":"hotmail.com","yaho.com":"yahoo.com","yahooo.com":"yahoo.com","yahoo.con":"yahoo.com","outlok.com":"outlook.com","outlook.con":"outlook.com","iclod.com":"icloud.com","aol.con":"aol.com" };

export function fixPhone(v, cc = "1") {
  v = (v || "").trim(); if (!v || /^\+\d{8,15}$/.test(v)) return null;
  const v2 = v.split(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i)[0].trim();
  let d = v2.replace(/\D/g, ""); if (v2.startsWith("00")) d = d.slice(2);
  let out;
  if (v2.startsWith("+") || v2.startsWith("00")) out = "+" + d;
  else if (d.length === 10 && cc === "1") out = "+1" + d;
  else if (d.length === 11 && d.startsWith("1") && cc === "1") out = "+" + d;
  else return null; // can't be sure: leave for a person
  return out.length >= 9 && out.length <= 16 && out !== v ? out : null;
}
export function fixEmail(v) {
  v = (v || "").trim(); if (!v) return null;
  let e = v.toLowerCase().replace(/\s/g, "");
  const i = e.lastIndexOf("@");
  if (i > 0) { let dom = e.slice(i + 1); dom = EMAIL_TYPOS[dom] || dom.replace(/\.(con|cmo|ocm)$/, ".com"); e = e.slice(0, i) + "@" + dom; }
  return EMAIL_RE.test(e) && e !== v ? e : null;
}
export function fixName(v) {
  v = (v || "").replace(/\s+/g, " ").trim();
  if (!v || !/[a-z]/i.test(v) || (v !== v.toUpperCase() && v !== v.toLowerCase())) return null;
  const n = v.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\bMc([a-z])/g, (m, a) => "Mc" + a.toUpperCase());
  return n !== v ? n : null;
}

async function allContacts(maxPages) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await READS["contacts.search"]({ page, limit: 100 });
    const batch = r.contacts || [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}
const nameOf = c => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.contactName || c.email || c.phone || c.id;

const JOBS = {
  async format(ctx) {
    const found = [];
    for (const c of await ctx.contacts()) {
      const payload = {}, why = [];
      const p = fixPhone(c.phone); if (p) { payload.phone = p; why.push(`phone ${c.phone} → ${p}`); }
      const e = fixEmail(c.email); if (e) { payload.email = e; why.push(`email ${c.email} → ${e}`); }
      for (const f of ["firstName", "lastName"]) { const n = fixName(c[f]); if (n) { payload[f] = n; why.push(`${f} ${c[f]} → ${n}`); } }
      if (why.length) found.push({ op: "contact.update", targetId: c.id, payload, reason: "Format fix: " + why.join("; "), before: c });
    }
    return found;
  },
  async duplicates(ctx) {
    const groups = {};
    for (const c of await ctx.contacts()) {
      const keys = [];
      if (c.email) keys.push("e:" + c.email.trim().toLowerCase());
      const ph = (c.phone || "").replace(/\D/g, "").slice(-10); if (ph.length === 10) keys.push("p:" + ph);
      for (const k of keys) (groups[k] = groups[k] || []).push(c);
    }
    const seen = new Set(), found = [];
    for (const [k, list] of Object.entries(groups)) {
      const uniq = [...new Map(list.map(c => [c.id, c])).values()];
      if (uniq.length < 2) continue;
      uniq.sort((a, b) => String(a.dateAdded || "").localeCompare(String(b.dateAdded || "")));
      const primary = uniq[0];
      for (const dup of uniq.slice(1)) {
        if (seen.has(dup.id) || (dup.tags || []).includes("glytch-duplicate")) continue;
        seen.add(dup.id);
        found.push({ op: "contact.addTags", targetId: dup.id, payload: { tags: ["glytch-duplicate"] },
          reason: `Possible duplicate of ${nameOf(primary)} (${primary.id}), same ${k.startsWith("e:") ? "email" : "phone"}. Tagged so you can merge it in GoHighLevel.`, before: dup });
      }
    }
    return found;
  },
  async "stale-opps"(ctx) {
    const days = ctx.staleDays, cutoff = Date.now() - days * 864e5, found = [];
    for (let page = 1; page <= ctx.maxPages; page++) {
      const r = await READS["opportunities.search"]({ status: "open", page, limit: 100 });
      const list = r.opportunities || [];
      for (const o of list) {
        const last = Date.parse(o.lastStatusChangeAt || o.updatedAt || o.createdAt || 0);
        const cid = o.contactId || o.contact?.id;
        if (!cid || !last || last > cutoff) continue;
        found.push({ op: "contact.addTags", targetId: cid, payload: { tags: ["glytch-follow-up"] },
          reason: `Open opportunity "${o.name}" hasn't moved in ${Math.floor((Date.now() - last) / 864e5)} days. Tag triggers your follow-up workflow.`, before: undefined });
      }
      if (list.length < 100) break;
    }
    return found;
  },
  async "tag-hygiene"() {
    const r = await READS.tags();
    const tags = (r.tags || []).map(t => t.name || t);
    const groups = {};
    for (const t of tags) (groups[t.toLowerCase().replace(/[\s_-]+/g, "")] = groups[t.toLowerCase().replace(/[\s_-]+/g, "")] || []).push(t);
    return { report: Object.values(groups).filter(g => g.length > 1).map(g => `Similar tags: ${g.join(" | ")}`) };
  },
};

export default async function handler(req, res) {
  const role = requireRole(req, res, ["admin", "agent", "cron"]);
  if (!role) return;
  try {
    const b = req.method === "POST" ? await readBody(req) : {};
    const job = b.job || "all";
    const ctx = { maxPages: Math.min(Number(b.maxPages) || 10, 50), staleDays: Number(b.staleDays) || 14 };
    let cache; ctx.contacts = async () => (cache ||= await allContacts(ctx.maxPages));
    const maxProposals = Math.min(Number(b.maxProposals) || 100, 500);
    const names = job === "all" ? Object.keys(JOBS) : [job];
    const summary = {};
    let budget = maxProposals;
    for (const name of names) {
      if (!JOBS[name]) return send(res, 400, { error: `Unknown job "${name}".`, allowed: ["all", ...Object.keys(JOBS)] });
      const result = await JOBS[name](ctx);
      if (!Array.isArray(result)) { summary[name] = result; continue; }
      let created = 0, dup = 0;
      for (const f of result) {
        if (budget <= 0) break;
        const { before, ...item } = f;
        const r = await createProposal({ ...item, source: `job:${name}` }, before);
        r.duplicate ? dup++ : (created++, budget--);
      }
      summary[name] = { found: result.length, proposed: created, alreadyPending: dup };
    }
    await store.log({ event: "job-run", job, by: role, summary });
    send(res, 200, { job, summary, note: "Nothing was changed in GoHighLevel. Review the proposals and approve what you want." });
  } catch (e) { handleError(res, e); }
}
