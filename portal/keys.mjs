// Keys & connections: owner enters tokens once in the portal; they're stored encrypted (AES-256-GCM)
// in Postgres and pulled by the gateway and bridge over Railway's private network with a service key.
import crypto from "node:crypto";

export const KEY_CATALOG = [
  { name: "COWBOY_BOT_TOKEN", group: "Telegram bots", label: "Cowboy bot token", help: "From @BotFather → /newbot. Looks like 123456789:AA…", for: "gateway", kind: "telegram" },
  { name: "GLYTCH_BOT_TOKEN", group: "Telegram bots", label: "GLYTCH bot token", help: "From @BotFather → /newbot.", for: "gateway", kind: "telegram" },
  { name: "PABLO_BOT_TOKEN", group: "Telegram bots", label: "Pablo bot token", help: "From @BotFather → /newbot.", for: "gateway", kind: "telegram" },
  { name: "GHL_PIT_SCR", group: "GoHighLevel", label: "Sweet Cypress Ranch token", help: "In the SCR sub-account: Settings → Private Integrations → Create. Starts with pit-", for: "bridge", kind: "ghl", location: "Yi87VWPlnhonig1izMbI" },
  { name: "GHL_PIT_OMEGA_UI", group: "GoHighLevel", label: "Omega UI token", help: "In the Omega UI sub-account: Settings → Private Integrations → Create. Starts with pit-", for: "bridge", kind: "ghl", location: "ZWn4tZCNq2k2f8xaA8PQ" },
  { name: "ANTHROPIC_API_KEY", group: "AI models", label: "Claude API key (optional)", help: "console.anthropic.com → API keys. Starts with sk-ant-", for: "gateway", kind: "anthropic" },
  { name: "RESEND_API_KEY", group: "Email", label: "Resend API key (sign-in emails)", help: "resend.com → API Keys. Starts with re_. Lets the portal email invite and password links.", for: "portal", kind: "resend" },
  { name: "GEMINI_API_KEY", group: "AI models", label: "Gemini key", help: "Already set. Replace only if you rotate it.", for: "gateway", kind: "gemini" },
];
const BY_NAME = Object.fromEntries(KEY_CATALOG.map(k => [k.name, k]));

export function keyring(secret) {
  const key = crypto.createHash("sha256").update("glytch-portal-secrets:" + secret).digest();
  return {
    seal(plain) {
      const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return [iv, c.getAuthTag(), enc].map(b => b.toString("base64")).join(".");
    },
    open(sealed) {
      const [iv, tag, enc] = sealed.split(".").map(s => Buffer.from(s, "base64"));
      const d = crypto.createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
    },
  };
}

// light live check so a typo is caught at save time; network failure never blocks saving
export async function checkKey(name, value) {
  const k = BY_NAME[name];
  const ctrl = AbortSignal.timeout(10000);
  try {
    if (k.kind === "telegram") {
      if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(value)) return { ok: false, note: "That doesn't look like a BotFather token (123456789:AA…)." };
      const j = await fetch(`${process.env.TELEGRAM_API_BASE || "https://api.telegram.org"}/bot${value}/getMe`, { signal: ctrl }).then(r => r.json());
      return j.ok ? { ok: true, note: `Connected to @${j.result.username}` } : { ok: false, note: "Telegram rejected this token." };
    }
    if (k.kind === "ghl") {
      if (!/^pit-[0-9a-f-]{20,}$/i.test(value)) return { ok: false, note: "GoHighLevel private integration tokens start with pit-" };
      const r = await fetch(`${process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com"}/contacts/?locationId=${k.location}&limit=1`, { headers: { Authorization: `Bearer ${value}`, Version: "2021-07-28" }, signal: ctrl });
      return r.ok ? { ok: true, note: "Reads contacts in this sub-account" } : { ok: false, note: `GoHighLevel said ${r.status}. Check the token's scopes include contacts.` };
    }
    if (k.kind === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": value, "anthropic-version": "2023-06-01" }, signal: ctrl });
      return r.ok ? { ok: true, note: "Claude key works" } : { ok: false, note: `Anthropic said ${r.status}.` };
    }
    if (k.kind === "resend") {
      if (!/^re_[A-Za-z0-9_]{10,}$/.test(value)) return { ok: false, note: "Resend keys start with re_" };
      const r = await fetch(`${process.env.RESEND_API_BASE || "https://api.resend.com"}/domains`, { headers: { Authorization: `Bearer ${value}` }, signal: ctrl });
      if (r.status === 401 || r.status === 403) { const t = await r.text(); if (!/restricted/i.test(t)) return { ok: false, note: "Resend rejected this key." }; }
      return { ok: true, note: "Resend key works" };
    }
    return { ok: true, note: "Saved" };
  } catch (e) { return { ok: true, note: "Saved (couldn't verify right now)", unverified: true }; }
}

export function knownKey(name) { return BY_NAME[name]; }
