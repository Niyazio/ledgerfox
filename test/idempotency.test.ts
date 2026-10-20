import { describe, expect, it, beforeAll } from "vitest";
import { world, register, contact, type World } from "./helpers";

let A: World;
let customer: string;
const invoice = () => ({ doc_type: "invoice", contact_id: customer, issue_date: "2026-05-05", lines: [{ description: "Offline sale", quantity: "1", unit_price: "250" }] });

beforeAll(async () => {
  A = await world();
  customer = await contact(A, "customer", { state_code: "29" });
});

describe("Idempotency-Key replay protection", () => {
  it("a repeated create with the same key returns the first result and creates nothing new", async () => {
    const key = crypto.randomUUID();
    const first = await A.owner.req("POST", A.c("/documents"), invoice(), { "idempotency-key": key });
    expect(first.status).toBe(201);
    const again = await A.owner.req("POST", A.c("/documents"), invoice(), { "idempotency-key": key });
    expect(again.status).toBe(first.status);
    expect(again.json.id).toBe(first.json.id);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    const n = await A.env.DB.prepare("SELECT COUNT(*) AS n FROM documents WHERE company_id = ? AND id = ?").bind(A.companyId, first.json.id).first<{ n: number }>();
    expect(n?.n).toBe(1);
    const all = await A.owner.get(A.c("/documents?doc_type=invoice"));
    expect(all.json.documents.filter((d: any) => d.id === first.json.id)).toHaveLength(1);
  });

  it("follow-up actions (issue) are also replay-safe", async () => {
    const created = await A.owner.post(A.c("/documents"), invoice());
    const key = crypto.randomUUID() + ".then";
    const a = await A.owner.req("POST", A.c(`/documents/${created.json.id}/issue`), {}, { "idempotency-key": key });
    expect(a.status).toBe(200);
    const b = await A.owner.req("POST", A.c(`/documents/${created.json.id}/issue`), {}, { "idempotency-key": key });
    expect(b.status).toBe(200);
    expect(b.headers.get("idempotent-replay")).toBe("true");
    // Without the key a second issue is rejected, proving the replay did not run the action again.
    expect((await A.owner.post(A.c(`/documents/${created.json.id}/issue`))).status).toBeGreaterThanOrEqual(400);
  });

  it("failed requests release the key so a corrected retry works", async () => {
    const key = crypto.randomUUID();
    const bad = await A.owner.req("POST", A.c("/documents"), { ...invoice(), lines: [] }, { "idempotency-key": key });
    expect(bad.status).toBe(400);
    const ok = await A.owner.req("POST", A.c("/documents"), invoice(), { "idempotency-key": key });
    expect(ok.status).toBe(201);
  });

  it("rejects reuse of a key on a different endpoint and malformed keys", async () => {
    const key = crypto.randomUUID();
    expect((await A.owner.req("POST", A.c("/documents"), invoice(), { "idempotency-key": key })).status).toBe(201);
    const other = await A.owner.req("POST", A.c("/contacts"), { kind: "customer", name: "Reuse" }, { "idempotency-key": key });
    expect(other.status).toBe(422);
    expect((await A.owner.req("POST", A.c("/contacts"), { kind: "customer", name: "Bad key" }, { "idempotency-key": "x" })).status).toBe(400);
  });

  it("an in-flight key answers 409 IN_PROGRESS; a stale one is retried", async () => {
    const key = crypto.randomUUID();
    const user = (await A.owner.get("/api/auth/me")).json.user.id;
    await A.env.DB.prepare("INSERT INTO idempotency_keys (company_id, user_id, key, method, path, created_at) VALUES (?, ?, ?, 'POST', ?, ?)")
      .bind(A.companyId, user, key, A.c("/documents"), Date.now()).run();
    const busy = await A.owner.req("POST", A.c("/documents"), invoice(), { "idempotency-key": key });
    expect(busy.status).toBe(409);
    expect(busy.json.error.code).toBe("IN_PROGRESS");
    await A.env.DB.prepare("UPDATE idempotency_keys SET created_at = ? WHERE key = ?").bind(Date.now() - 10 * 60_000, key).run();
    expect((await A.owner.req("POST", A.c("/documents"), invoice(), { "idempotency-key": key })).status).toBe(201);
  });

  it("keys are scoped per user: another member cannot read someone else's stored response", async () => {
    const key = crypto.randomUUID();
    const first = await A.owner.req("POST", A.c("/contacts"), { kind: "customer", name: "Scoped" }, { "idempotency-key": key });
    expect(first.status).toBe(201);
    const m = await register(A.env, "Accountant");
    const inv = await A.owner.post(`/api/orgs/${A.orgId}/invitations`, { email: m.email, role: "accountant" });
    expect((await m.client.post("/api/invitations/accept", { token: inv.json.token })).status).toBe(200);
    const second = await m.client.req("POST", A.c("/contacts"), { kind: "customer", name: "Scoped 2" }, { "idempotency-key": key });
    expect(second.status).toBe(201);
    expect(second.json.id).not.toBe(first.json.id);
  });
});
