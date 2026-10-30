/**
 * Automatic local copy: while the app is signed in and online, every company the person can open is saved as a full
 * data file in a folder on this computer (default Documents\LedgerFox Data, changeable in File → Local copy folder).
 * The LedgerFox cloud (D1) stays the main copy; this one is for the customer's own records, with no manual export.
 *
 * Layout: <folder>/<Company>/<Company> - latest.json (always the newest) and <Company> - YYYY-MM-DD.json (one per
 * day, the newest 30 kept). Files are written to a temporary name first and then renamed, so a copy is never half
 * written. The downloads run inside the signed-in page, with its own session; nothing else is sent anywhere.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** The part of Electron's WebContents used here (kept local so the website's checks need no Electron install). */
export interface PageRunner { executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> }

const KEEP_DAYS = 30;
// eslint-disable-next-line no-control-regex -- control characters are not allowed in Windows file names
const safeName = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").replace(/[. ]+$/, "").slice(0, 80) || "Company";

/** Runs in the page: the signed-in person's companies, or null when signed out or offline. */
const LIST_JS = `(async () => {
  if (!navigator.onLine) return null;
  const r = await fetch("/api/auth/me", { headers: { "x-requested-with": "ledgerfox" }, cache: "no-store" });
  if (!r.ok) return null;
  const me = await r.json();
  return me.user ? me.companies.map((c) => ({ id: c.id, name: c.name })) : null;
})()`;

const exportJs = (id: string) => `(async () => {
  const r = await fetch("/api/c/${id}/export", { headers: { "x-requested-with": "ledgerfox", "x-ledgerfox-local-copy": "1" }, cache: "no-store" });
  return r.ok ? await r.text() : null;
})()`;

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.part`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Save every company once. Returns how many were saved; throws only for problems with the folder. */
export async function saveLocalCopy(page: PageRunner, folder: string): Promise<number> {
  const list = (await page.executeJavaScript(LIST_JS, true).catch(() => null)) as { id: string; name: string }[] | null;
  if (!list?.length) return 0;
  mkdirSync(folder, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  let saved = 0;
  for (const co of list) {
    if (!/^[0-9a-f-]{36}$/.test(co.id)) continue;
    const text = (await page.executeJavaScript(exportJs(co.id), true).catch(() => null)) as string | null;
    if (!text || !text.startsWith("{")) continue;
    const name = safeName(co.name);
    const dir = join(folder, name);
    mkdirSync(dir, { recursive: true });
    const latest = join(dir, `${name} - latest.json`);
    // Skip rewriting when nothing changed since the last copy (the export time itself is ignored).
    const digest = (t: string) => createHash("sha256").update(t.replace(/"exported_at":"[^"]*"/, "")).digest("hex");
    const same = existsSync(latest) && digest(readFileSync(latest, "utf8")) === digest(text);
    if (!same) writeAtomic(latest, text);
    const daily = join(dir, `${name} - ${today}.json`);
    if (!same || !existsSync(daily)) writeAtomic(daily, text);
    const old = readdirSync(dir).filter((f) => /^.+ - \d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(KEEP_DAYS);
    for (const f of old) rmSync(join(dir, f), { force: true });
    saved++;
  }
  return saved;
}
