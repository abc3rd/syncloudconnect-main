// Local runner: serves index.html and /api/* exactly like Vercel's Node runtime would.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function startBridge(port = 4020) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/api/")) {
      const name = u.pathname.slice(5).replace(/[^a-z-]/g, "");
      const file = path.join(root, "api", name + ".js");
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end("{}"); }
      try { (await import(file)).default(req, res); } catch (e) { res.writeHead(500); res.end(String(e)); }
      return;
    }
    const f = path.join(root, u.pathname === "/" ? "index.html" : u.pathname);
    if (f.startsWith(root) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html" : "text/plain" }); return res.end(fs.readFileSync(f)); }
    res.writeHead(404); res.end("not found");
  });
  return new Promise(r => server.listen(port, () => r(server)));
}
