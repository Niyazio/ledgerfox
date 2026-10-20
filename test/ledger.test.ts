import { describe, expect, it, beforeAll } from "vitest";
import { world, rawQuery, type World } from "./helpers";

let w: World;
beforeAll(async () => { w = await world(); });

const jl = (account_id: string, debit: string | null, credit: string | null, extra = {}) => ({ account_id, debit, credit, ...extra });

describe("journal posting", () => {
  it("rejects an unbalanced journal on posting", async () => {
    const r = await w.owner.post(w.c("/journals"), {
      entry_date: "2026-05-10", post: true,
      lines: [jl(w.acc.CASH, "100.00", null), jl(w.acc.CAPITAL, null, "99.99")],
    });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("UNBALANCED");
    const n = await rawQuery(w, `SELECT COUNT(*) AS n FROM journal_entries WHERE company_id = ?`, w.companyId);
    expect(n[0].n).toBe(0); // nothing persisted
  });

  it("rejects lines with both debit and credit, or negatives", async () => {
    const r = await w.owner.post(w.c("/journals"), { entry_date: "2026-05-10", post: true, lines: [jl(w.acc.CASH, "10", "10"), jl(w.acc.CAPITAL, null, "0")] });
    expect(r.status).toBe(422);
    const r2 = await w.owner.post(w.c("/journals"), { entry_date: "2026-05-10", post: true, lines: [jl(w.acc.CASH, "-10", null), jl(w.acc.CAPITAL, null, "-10")] });
    expect(r2.status).toBe(422);
  });

  it("rejects posting to a group account", async () => {
    const r = await w.owner.post(w.c("/journals"), { entry_date: "2026-05-10", post: true, lines: [jl(w.acc["1100"], "10", null), jl(w.acc.CAPITAL, null, "10")] });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("INVALID_ACCOUNT");
  });

  let posted: string;
  it("posts a balanced journal with a sequential number", async () => {
    const r = await w.owner.post(w.c("/journals"), {
      entry_date: "2026-05-10", post: true, memo: "Owner capital",
      lines: [jl(w.acc.BANK, "50000.00", null), jl(w.acc.CAPITAL, null, "50000.00")],
    });
    expect(r.status).toBe(201);
    expect(r.json.entry_number).toBe("JV-00001");
    posted = r.json.id;
    const e = await w.owner.get(w.c(`/journals/${posted}`));
    expect(e.json.entry.status).toBe("posted");
    expect(e.json.entry.total).toBe(5000000);
  });

  it("posted entries cannot be edited or deleted through the API", async () => {
    const r = await w.owner.put(w.c(`/journals/${posted}`), { entry_date: "2026-05-11", lines: [jl(w.acc.BANK, "1", null), jl(w.acc.CAPITAL, null, "1")] });
    expect(r.status).toBe(409);
    const d = await w.owner.del(w.c(`/journals/${posted}`));
    expect(d.status).toBe(409);
  });

  it("database triggers block direct tampering with posted data", async () => {
    await expect(w.env.DB.prepare(`UPDATE journal_lines SET debit = 1 WHERE entry_id = ?`).bind(posted).run()).rejects.toThrow(/POSTED_IMMUTABLE/);
    await expect(w.env.DB.prepare(`DELETE FROM journal_lines WHERE entry_id = ?`).bind(posted).run()).rejects.toThrow(/POSTED_IMMUTABLE/);
    await expect(w.env.DB.prepare(`UPDATE journal_entries SET memo = 'x' WHERE id = ?`).bind(posted).run()).rejects.toThrow(/POSTED_IMMUTABLE/);
    await expect(w.env.DB.prepare(`DELETE FROM journal_entries WHERE id = ?`).bind(posted).run()).rejects.toThrow(/POSTED_IMMUTABLE/);
    await expect(w.env.DB.prepare(`INSERT INTO journal_lines (id, entry_id, company_id, line_no, account_id, debit, credit) VALUES ('x', ?, ?, 9, ?, 5, 0)`).bind(posted, w.companyId, w.acc.CASH).run()).rejects.toThrow(/POSTED_IMMUTABLE/);
  });

  it("database trigger rejects an unbalanced draft being flipped to posted", async () => {
    const r = await w.owner.post(w.c("/journals"), { entry_date: "2026-05-12", lines: [jl(w.acc.CASH, "10", null), jl(w.acc.CAPITAL, null, "10")] });
    expect(r.status).toBe(201);
    await w.env.DB.prepare(`UPDATE journal_lines SET debit = 999 WHERE entry_id = ? AND debit > 0`).bind(r.json.id).run(); // draft can change
    await expect(w.env.DB.prepare(`UPDATE journal_entries SET status = 'posted', total = 999 WHERE id = ?`).bind(r.json.id).run()).rejects.toThrow(/UNBALANCED/);
    await w.owner.del(w.c(`/journals/${r.json.id}`));
  });

  it("drafts can be edited, then posted; posting twice is rejected", async () => {
    const r = await w.owner.post(w.c("/journals"), { entry_date: "2026-05-12", memo: "draft", lines: [jl(w.acc.CASH, "10", null), jl(w.acc.CAPITAL, null, "10")] });
    const id = r.json.id;
    const u = await w.owner.put(w.c(`/journals/${id}`), { entry_date: "2026-05-13", memo: "edited", lines: [jl(w.acc.CASH, "20", null), jl(w.acc.CAPITAL, null, "20")] });
    expect(u.status).toBe(200);
    const p = await w.owner.post(w.c(`/journals/${id}/post`));
    expect(p.status).toBe(200);
    expect(p.json.entry_number).toBe("JV-00002");
    const p2 = await w.owner.post(w.c(`/journals/${id}/post`));
    expect(p2.status).toBe(409);
  });

  it("concurrent posting of the same draft succeeds exactly once", async () => {
    const r = await w.owner.post(w.c("/journals"), { entry_date: "2026-05-14", lines: [jl(w.acc.CASH, "5", null), jl(w.acc.CAPITAL, null, "5")] });
    const results = await Promise.all([1, 2, 3, 4].map(() => w.owner.post(w.c(`/journals/${r.json.id}/post`))));
    expect(results.filter((x) => x.status === 200).length).toBe(1);
    expect(results.filter((x) => x.status === 409).length).toBe(3);
    const nums = await rawQuery(w, `SELECT entry_number FROM journal_entries WHERE company_id = ? AND status = 'posted'`, w.companyId);
    expect(new Set(nums.map((n) => n.entry_number)).size).toBe(nums.length); // no duplicate numbers
  });

  it("concurrent independent postings get unique gap-free numbers", async () => {
    const before = await rawQuery(w, `SELECT COUNT(*) AS n FROM journal_entries WHERE company_id = ? AND status = 'posted'`, w.companyId);
    await Promise.all(Array.from({ length: 6 }, (_, i) => w.owner.post(w.c("/journals"), { entry_date: "2026-05-15", post: true, lines: [jl(w.acc.CASH, `${i + 1}`, null), jl(w.acc.CAPITAL, null, `${i + 1}`)] })));
    const rows = await rawQuery(w, `SELECT entry_number FROM journal_entries WHERE company_id = ? AND status = 'posted' ORDER BY entry_number`, w.companyId);
    expect(rows.length).toBe(before[0].n + 6);
    const nums = rows.map((r) => Number(r.entry_number.slice(3))).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1));
  });

  it("idempotency key prevents duplicate posting", async () => {
    const body = { entry_date: "2026-05-16", post: true, idempotency_key: "import-row-0001", lines: [jl(w.acc.CASH, "7", null), jl(w.acc.CAPITAL, null, "7")] };
    const a = await w.owner.post(w.c("/journals"), body);
    const b = await w.owner.post(w.c("/journals"), body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.json.duplicate).toBe(true);
    expect(b.json.id).toBe(a.json.id);
  });

  it("reversal creates an equal and opposite entry, once only", async () => {
    const r = await w.owner.post(w.c(`/journals/${posted}/reverse`), { date: "2026-05-20" });
    expect(r.status).toBe(201);
    const rev = await w.owner.get(w.c(`/journals/${r.json.id}`));
    expect(rev.json.entry.kind).toBe("reversal");
    expect(rev.json.entry.reversal_of_id).toBe(posted);
    const bank = rev.json.lines.find((l: any) => l.account_id === w.acc.BANK);
    expect(bank.credit).toBe(5000000);
    const again = await w.owner.post(w.c(`/journals/${posted}/reverse`), { date: "2026-05-20" });
    expect(again.status).toBe(409);
    const revRev = await w.owner.post(w.c(`/journals/${r.json.id}/reverse`), { date: "2026-05-21" });
    expect(revRev.status).toBe(409);
  });

  it("balances net to zero after reversal", async () => {
    const tb = await w.owner.get(w.c("/reports/trial-balance?from=2026-04-01&to=2026-05-31"));
    const bank = tb.json.rows.find((r: any) => r.id === w.acc.BANK);
    expect(bank?.closing ?? 0).toBe(0);
    expect(tb.json.balanced).toBe(true);
  });
});

describe("period locking", () => {
  it("blocks posting into a locked period and allows after unlock", async () => {
    const fy = await w.owner.get(w.c("/settings/fiscal-years"));
    const june = fy.json.periods.find((p: any) => p.start_date === "2026-06-01");
    expect((await w.owner.post(w.c(`/settings/periods/${june.id}/lock`))).status).toBe(200);
    const r = await w.owner.post(w.c("/journals"), { entry_date: "2026-06-15", post: true, lines: [jl(w.acc.CASH, "1", null), jl(w.acc.CAPITAL, null, "1")] });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("PERIOD_CLOSED");
    // the failed batch left no partial rows behind (rollback)
    const orphans = await rawQuery(w, `SELECT COUNT(*) AS n FROM journal_entries WHERE company_id = ? AND entry_date = '2026-06-15'`, w.companyId);
    expect(orphans[0].n).toBe(0);
    // sequence was not consumed by the failed attempt
    const seq1 = await rawQuery(w, `SELECT next_value FROM number_sequences WHERE company_id = ? AND key = 'JV'`, w.companyId);
    await w.owner.post(w.c(`/settings/periods/${june.id}/unlock`));
    const ok = await w.owner.post(w.c("/journals"), { entry_date: "2026-06-15", post: true, lines: [jl(w.acc.CASH, "1", null), jl(w.acc.CAPITAL, null, "1")] });
    expect(ok.status).toBe(201);
    expect(ok.json.entry_number).toBe(`JV-${String(seq1[0].next_value).padStart(5, "0")}`);
  });

  it("rejects dates with no fiscal period", async () => {
    const r = await w.owner.post(w.c("/journals"), { entry_date: "2020-01-01", post: true, lines: [jl(w.acc.CASH, "1", null), jl(w.acc.CAPITAL, null, "1")] });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("PERIOD_CLOSED");
  });

  it("lock-through closes all earlier periods", async () => {
    await w.owner.post(w.c("/settings/periods/lock-through"), { date: "2025-12-31" });
    const r = await w.owner.post(w.c("/journals"), { entry_date: "2025-11-15", post: true, lines: [jl(w.acc.CASH, "1", null), jl(w.acc.CAPITAL, null, "1")] });
    expect(r.json.error.code).toBe("PERIOD_CLOSED");
  });
});

describe("opening balances", () => {
  it("posts opening balances with the difference to Opening Balance Equity", async () => {
    const r = await w.owner.post(w.c("/journals/opening-balances"), {
      date: "2026-04-01",
      lines: [{ account_id: w.acc.CASH, debit: "1000.00" }, { account_id: w.acc["1210"], debit: "25000.00" }, { account_id: w.acc["2210"], credit: "20000.00" }],
    });
    expect(r.status).toBe(201);
    const e = await w.owner.get(w.c(`/journals/${r.json.id}`));
    const obe = e.json.lines.find((l: any) => l.account_id === w.acc.OPENING_EQUITY);
    expect(obe.credit).toBe(600000);
    const dup = await w.owner.post(w.c("/journals/opening-balances"), { date: "2026-04-01", lines: [{ account_id: w.acc.CASH, debit: "1" }] });
    expect(dup.status).toBe(409);
  });
});

describe("audit trail", () => {
  it("records financial actions and is append-only", async () => {
    const log = await w.owner.get(w.c("/settings/audit-log"));
    const actions = log.json.entries.map((e: any) => e.action);
    expect(actions).toContain("journal.create_post");
    expect(actions).toContain("journal.reverse");
    expect(actions).toContain("period.lock");
    await expect(w.env.DB.prepare(`DELETE FROM audit_logs`).run()).rejects.toThrow(/AUDIT_IMMUTABLE/);
    await expect(w.env.DB.prepare(`UPDATE audit_logs SET action = 'x'`).run()).rejects.toThrow(/AUDIT_IMMUTABLE/);
  });
});
