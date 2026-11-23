// Fake GoHighLevel API for tests. Records every write so tests can prove nothing changed before approval.
import http from "node:http";
export function startMockGhl(port = 4010) {
  const old = new Date(Date.now() - 40 * 864e5).toISOString();
  const db = {
    contacts: [
      { id: "c1", firstName: "JOHN", lastName: "SMITH", email: "John.Smith@GMIAL.com", phone: "(239) 555-0123", tags: ["vip"], dateAdded: "2026-01-01" },
      { id: "c2", firstName: "John", lastName: "Smith", email: "john.smith@gmail.com", phone: "+12395550123", tags: [], dateAdded: "2026-03-01" },
      { id: "c3", firstName: "Maria", lastName: "Garcia", email: "maria@yahoo.com", phone: "+12395550456", tags: ["Lead"], dateAdded: "2026-02-01" },
      { id: "c4", firstName: "carla", lastName: "diaz", email: "carla@diaz.com", phone: "239.555.0777", tags: ["lead"], dateAdded: "2026-02-05" },
    ],
    opps: [
      { id: "o1", name: "Smith kitchen remodel", status: "open", contactId: "c3", lastStatusChangeAt: old },
      { id: "o2", name: "Diaz lawn plan", status: "open", contactId: "c4", lastStatusChangeAt: new Date().toISOString() },
    ],
    tags: [{ name: "vip" }, { name: "Lead" }, { name: "lead" }, { name: "follow up" }, { name: "follow-up" }],
    writes: [], notes: [],
  };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x"); let body = "";
    for await (const c of req) body += c;
    let j = {}; try { j = body ? JSON.parse(body) : {}; } catch {}
    const ok = d => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    const no = (s, m) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify({ message: m })); };
    const auth = req.headers.authorization || "";
    // agency-token simulation: agency token can read locations + mint location tokens, nothing else
    if (auth === "Bearer agency-pit") {
      db.agencyCalls = (db.agencyCalls || 0) + 1;
      if (req.method === "GET" && /^\/locations\/[^/]+$/.test(u.pathname)) return ok({ location: { id: u.pathname.split("/")[2], name: "Agency view of " + u.pathname.split("/")[2], companyId: "comp1" } });
      if (req.method === "POST" && u.pathname === "/oauth/locationToken") {
        const f = new URLSearchParams(body);
        if (f.get("companyId") !== "comp1") return no(400, "bad company");
        return ok({ access_token: "loc-token-" + f.get("locationId"), expires_in: 86399, locationId: f.get("locationId") });
      }
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ statusCode: 401, message: "This authClass type is not allowed to access this scope. Please reach out to the Platform team to get it added." }));
    }
    const m2 = auth.match(/^Bearer loc-token-(.+)$/);
    if (m2) { db.locCalls = db.locCalls || []; db.locCalls.push(m2[1]); }
    else if (auth !== "Bearer test-pit") return no(401, "Invalid token");
    if (!req.headers.version) return no(400, "Version header required");
    const p = u.pathname, m = req.method;
    let mm;
    if (m === "GET" && /^\/locations\/[^/]+$/.test(p)) return ok({ location: { id: p.split("/")[2], name: p === "/locations/loc1" ? "SynCloud Test Location" : "Location " + p.split("/")[2] } });
    if (m === "GET" && /^\/locations\/[^/]+\/tags$/.test(p)) return ok({ tags: db.tags });
    if (m === "POST" && p === "/contacts/search") { const s = (j.page - 1) * j.pageLimit; const q = (j.query || "").toLowerCase();
      const list = db.contacts.filter(c => !q || JSON.stringify(c).toLowerCase().includes(q)); return ok({ contacts: list.slice(s, s + j.pageLimit), total: list.length }); }
    if ((mm = p.match(/^\/contacts\/([^/]+)$/))) {
      const c = db.contacts.find(x => x.id === mm[1]);
      if (m === "GET") return c ? ok({ contact: { ...c, dateUpdated: "x", customFields: [] } }) : no(404, "Contact not found");
      if (m === "PUT") { if (!c) return no(404, "nf"); db.writes.push({ m, p, j }); Object.assign(c, j); return ok({ contact: c, succeded: true }); }
      if (m === "DELETE") { db.writes.push({ m, p }); db.contacts = db.contacts.filter(x => x.id !== mm[1]); return ok({ succeded: true }); }
    }
    if ((mm = p.match(/^\/contacts\/([^/]+)\/tags$/))) { const c = db.contacts.find(x => x.id === mm[1]); db.writes.push({ m, p, j });
      if (m === "POST") c.tags = [...new Set([...(c.tags || []), ...j.tags])]; else c.tags = c.tags.filter(t => !j.tags.includes(t)); return ok({ tags: c.tags }); }
    if ((mm = p.match(/^\/contacts\/([^/]+)\/notes$/))) { if (m === "GET") return ok({ notes: db.notes.filter(n => n.contactId === mm[1]) });
      db.writes.push({ m, p, j }); db.notes.push({ contactId: mm[1], body: j.body }); return ok({ note: { id: "n" + db.notes.length } }); }
    if (m === "POST" && p === "/contacts/") { db.writes.push({ m, p, j }); const c = { id: "c" + (db.contacts.length + 10), ...j }; db.contacts.push(c); return ok({ contact: c }); }
    if (m === "GET" && p === "/opportunities/search") return ok({ opportunities: db.opps.filter(o => !u.searchParams.get("status") || o.status === u.searchParams.get("status")) });
    if (m === "GET" && p === "/opportunities/pipelines") return ok({ pipelines: [{ id: "pl1", name: "Sales" }] });
    return no(404, `mock: no route ${m} ${p}`);
  });
  return new Promise(r => server.listen(port, () => r({ server, db })));
}
