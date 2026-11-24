// Site inventory + uptime audit for GLYTCH. Inventory comes from the Cloud Connect URL datasheet (secrets stripped).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export const SITES = JSON.parse(fs.readFileSync(path.join(here, "sites.json"), "utf8"));

async function probe(url, timeoutMs = 15000) {
  const hops = []; let cur = url;
  for (let i = 0; i < 6; i++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const r = await fetch(cur, { redirect: "manual", signal: ctrl.signal, headers: { "user-agent": "GLYTCH-SiteAudit/1.0 (+https://glytch.cloud)" } });
      const ms = Date.now() - t0;
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        hops.push(r.status); cur = new URL(r.headers.get("location"), cur).href; r.body?.cancel?.(); continue;
      }
      let title = "", notFound = false;
      if ((r.headers.get("content-type") || "").includes("html")) {
        const html = (await r.text()).slice(0, 200000);
        title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 120);
        notFound = /page (not found|doesn.t exist)|404/i.test(title);
      } else r.body?.cancel?.();
      const verdict = r.status >= 400 || notFound ? "broken" : hops.length ? "redirects" : "ok";
      return { url, status: r.status, final: cur, redirects: hops, ms, title, verdict };
    } catch (e) {
      return { url, status: 0, final: cur, redirects: hops, ms: Date.now() - t0, title: "", verdict: "down", error: e.name === "AbortError" ? "timeout" : (e.cause?.code || e.message) };
    } finally { clearTimeout(t); }
  }
  return { url, status: 0, final: cur, redirects: hops, verdict: "broken", error: "too many redirects" };
}

export async function auditSites(list = SITES, concurrency = 8) {
  const out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < list.length) { const k = i++; out[k] = { ...list[k], ...(await probe(list[k].url)) }; }
  }));
  return { at: new Date().toISOString(), results: out };
}

export function summarize(audit) {
  const c = { ok: 0, redirects: 0, broken: 0, down: 0 };
  for (const r of audit.results) c[r.verdict]++;
  return c;
}
