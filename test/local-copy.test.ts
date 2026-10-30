import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { world, rawQuery } from "./helpers";
import { saveLocalCopy } from "../src/desktop/localcopy";

/** The desktop app runs its downloads inside the signed-in page; here the "page" is a signed-in test client. */
function fakePage(W: Awaited<ReturnType<typeof world>>, online = true) {
  return {
    executeJavaScript: async (js: string) => {
      if (!online) return null;
      if (js.includes("/api/auth/me")) {
        const me = (await W.owner.get("/api/auth/me")).json;
        return me.companies.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }));
      }
      const id = /\/api\/c\/([0-9a-f-]{36})\/export/.exec(js)![1];
      const r = await W.owner.req("GET", `/api/c/${id}/export`, undefined, { "x-ledgerfox-local-copy": "1" });
      return r.status === 200 ? JSON.stringify(r.json) : null;
    },
  } as unknown as WebContents;
}

describe("desktop automatic local copy", () => {
  it("saves every company to the chosen folder, keeps a daily copy, and records it in the audit trail once a day", async () => {
    const W = await world();
    await W.owner.post(W.c("/contacts"), { kind: "customer", name: "Local Copy Customer" });
    const folder = mkdtempSync(join(tmpdir(), "lf-copy-"));
    expect(await saveLocalCopy(fakePage(W), folder)).toBe(1);
    const [dir] = readdirSync(folder);
    const files = readdirSync(join(folder, dir)).sort();
    const today = new Date().toISOString().slice(0, 10);
    expect(files).toEqual([`${dir} - ${today}.json`, `${dir} - latest.json`]);
    const data = JSON.parse(readFileSync(join(folder, dir, `${dir} - latest.json`), "utf8"));
    expect(data.format).toBe("ledgerfox-company-export");
    expect(data.contacts.map((c: { name: string }) => c.name)).toContain("Local Copy Customer");

    // Again (the app does this every 15 minutes): one audit line a day, and new data reaches the copy.
    await W.owner.post(W.c("/contacts"), { kind: "customer", name: "Second Customer" });
    await saveLocalCopy(fakePage(W), folder);
    const latest = JSON.parse(readFileSync(join(folder, dir, `${dir} - latest.json`), "utf8"));
    expect(latest.contacts).toHaveLength(data.contacts.length + 1);
    expect((await rawQuery(W, `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'company.local_copy'`))[0].n).toBe(1);
    expect(readdirSync(join(folder, dir)).some((f) => f.endsWith(".part"))).toBe(false);
  });

  it("keeps the newest 30 daily copies and does nothing offline", async () => {
    const W = await world();
    const folder = mkdtempSync(join(tmpdir(), "lf-copy-"));
    expect(await saveLocalCopy(fakePage(W, false), folder)).toBe(0);
    await saveLocalCopy(fakePage(W), folder);
    const [dir] = readdirSync(folder);
    for (let d = 1; d <= 40; d++) writeFileSync(join(folder, dir, `${dir} - 2025-01-${String(d % 28 + 1).padStart(2, "0")}-${d}.json`), "{}");
    for (let d = 1; d <= 35; d++) writeFileSync(join(folder, dir, `${dir} - 2025-${String(Math.ceil(d / 28) + 1).padStart(2, "0")}-${String(d % 28 + 1).padStart(2, "0")}.json`), "{}");
    await saveLocalCopy(fakePage(W), folder);
    const daily = readdirSync(join(folder, dir)).filter((f) => /- \d{4}-\d{2}-\d{2}\.json$/.test(f));
    expect(daily).toHaveLength(30);
    expect(daily).toContain(`${dir} - ${new Date().toISOString().slice(0, 10)}.json`);
  });
});
