// GLYTCH bridge as an always-on Node server (Railway, a VPS, or local).
// Serves the GLYTCH screen and the same /api/* handlers Vercel would run,
// and runs the cleanup jobs once a day (proposals only; nothing is edited).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withLocation, locationFromReq, locations, selfTest } from "./api/_lib.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;
const handlers = {};
for (const f of fs.readdirSync(path.join(root, "api"))) {
  if (f.endsWith(".js") && !f.startsWith("_")) handlers[f.slice(0, -3)] = (await import(path.join(root, "api", f))).default;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  if (u.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (u.pathname.startsWith("/api/")) {
    const h = handlers[u.pathname.slice(5).replace(/\/$/, "")];
    if (!h) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end('{"error":"Not found"}'); }
    try { await withLocation(locationFromReq(req), () => h(req, res)); } catch (e) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (u.pathname === "/" || u.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(root, "index.html")));
  }
  res.writeHead(404); res.end("Not found");
});
server.listen(port, async () => {
  console.log(`GLYTCH bridge on :${port}; locations: ${Object.keys(locations()).join(", ") || "none set"}`);
  if (process.env.GHL_PIT || Object.keys(process.env).some(k => k.startsWith("GHL_PIT_"))) {
    try { console.log("GoHighLevel self-test:", JSON.stringify(await selfTest())); }
    catch (e) { console.log("GoHighLevel self-test failed:", e.message); }
  }
});

// Daily job run at 13:17 UTC (≈ 8:17 AM Eastern): proposals only
if (process.env.CRON_SECRET) {
  let lastDay = "";
  setInterval(async () => {
    const d = new Date(), day = d.toISOString().slice(0, 10);
    if (d.getUTCHours() === 13 && d.getUTCMinutes() >= 17 && lastDay !== day && process.env.GHL_PIT) {
      lastDay = day;
      for (const loc of Object.keys(locations())) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/jobs`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "x-glytch-location": loc } });
          console.log(`daily jobs [${loc}]:`, r.status, (await r.text()).slice(0, 300));
        } catch (e) { console.log(`daily jobs [${loc}] failed:`, e.message); }
      }
    }
  }, 60_000);
}
