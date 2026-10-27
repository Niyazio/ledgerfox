import type { Env } from "../env";

/**
 * Outgoing email (password reset, address verification, receipts, reminders) through Resend's HTTPS API. Off until
 * RESEND_API_KEY (a Worker secret) and EMAIL_FROM are set; the desktop and phone editions never send email.
 * Callers must not depend on delivery: every flow that sends mail also works, more slowly, without it.
 */
export const emailOn = (env: Env) => Boolean(env.RESEND_API_KEY && env.EMAIL_FROM) && env.APP_ENV !== "desktop" && env.APP_ENV !== "offline";

/** Addresses made up for username-only staff accounts cannot receive mail. */
export const deliverable = (to: string | null | undefined) => !!to && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) && !to.endsWith(".ledgerfox.local");

export interface Mail { to: string; subject: string; text: string; html?: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Plain HTML version of a plain-text mail: escaped, with links made clickable. */
export function textToHtml(text: string) {
  const body = esc(text).replace(/https:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`).replace(/\n/g, "<br>");
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#0f172a;max-width:560px">${body}</div>`;
}

export async function sendMail(env: Env, mail: Mail): Promise<boolean> {
  if (!emailOn(env) || !deliverable(mail.to)) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html ?? textToHtml(mail.text), reply_to: env.EMAIL_REPLY_TO || undefined }),
    });
    if (!res.ok) console.error(JSON.stringify({ level: "error", code: "EMAIL_FAILED", status: res.status }));
    return res.ok;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", code: "EMAIL_FAILED", message: (e as Error).message }));
    return false;
  }
}

/** The public address of this site for links in mail: APP_URL when set, otherwise the address the request came to. */
export function siteUrl(env: Env, requestUrl?: string) {
  if (env.APP_URL && /^https:\/\/[^/]+$/.test(env.APP_URL)) return env.APP_URL;
  return requestUrl ? new URL(requestUrl).origin : "https://ledgerfox.niyazio.com";
}
