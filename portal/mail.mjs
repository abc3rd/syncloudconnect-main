// Outbound email for sign-in links. Railway blocks SMTP on this plan, so mail goes over HTTPS (Resend).
export function mailReady() { return !!process.env.RESEND_API_KEY; }
export async function sendMail({ to, subject, text, html }) {
  if (!process.env.RESEND_API_KEY) return { sent: false, reason: "Email sending isn't set up yet (Keys & connections → Resend)." };
  const from = process.env.EMAIL_FROM || "GLYTCH Portal <portal@syncloudconnect.com>";
  try {
    const r = await fetch(`${process.env.RESEND_API_BASE || "https://api.resend.com"}/emails`, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { sent: false, reason: `Email service said ${r.status}: ${j.message || j.name || "error"}` };
    return { sent: true, id: j.id };
  } catch (e) { return { sent: false, reason: "Email service unreachable: " + e.message }; }
}
export function linkEmail({ name, link, kind }) {
  const invite = kind === "invite";
  const subject = invite ? "You're invited to the GLYTCH Portal" : "Your GLYTCH Portal sign-in link";
  const lead = invite ? "You've been given access to the GLYTCH Portal (SynCloud Connect · Omega UI, LLC)." : "Here's the link you asked for to set your GLYTCH Portal password.";
  const exp = invite ? "7 days" : "1 hour";
  const text = `Hi${name ? " " + name : ""},\n\n${lead}\n\nOpen this link to choose your password:\n${link}\n\nIt works once and expires in ${exp}. If you didn't ask for this, ignore this email.\n\nGLYTCH · Omega UI, LLC`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#222"><h2 style="color:#ea00ea;margin:0 0 12px">GLYTCH PORTAL</h2><p>Hi${name ? " " + esc(name) : ""},</p><p>${esc(lead)}</p><p style="margin:24px 0"><a href="${esc(link)}" style="background:#ea00ea;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Choose my password</a></p><p style="font-size:13px;color:#666">It works once and expires in ${exp}. If you didn't ask for this, ignore this email.</p><p style="font-size:12px;color:#999">SynCloud Connect · Omega UI, LLC · Fort Myers, FL</p></div>`;
  return { subject, text, html };
}
