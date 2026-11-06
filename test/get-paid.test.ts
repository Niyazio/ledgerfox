import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { world, contact, rawQuery, Client } from "./helpers";
import { reminderKind, sendPaymentReminders } from "../src/worker/services/collect";

afterEach(() => vi.restoreAllMocks());
const SECRET = "biz_key_secret_123", HOOK = "biz_webhook_secret";
const sign = (s: string, data: string) => createHmac("sha256", s).update(data).digest("hex");
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** Razorpay's API as seen with the business's own keys. */
function mockRazorpay(calls: any[] = []) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
    const u = String(url);
    calls.push({ url: u, auth: init?.headers?.authorization, body: init?.body ? JSON.parse(init.body) : null });
    if (u.startsWith("https://api.razorpay.com/v1/orders?")) return Response.json({ items: [] });
    if (u === "https://api.razorpay.com/v1/orders") return Response.json({ id: `order_${calls.length}` });
    if (u === "https://api.resend.com/emails") return Response.json({ id: "mail" });
    throw new Error(`unexpected fetch ${u}`);
  });
  return calls;
}

async function shop() {
  const W = await world();
  Object.assign(W.env, { DATA_KEY: "a-long-random-data-key-for-tests" });
  const cust = await contact(W, "customer", { name: "Lakeside Cafe", email: "accounts@lakeside.example" });
  const d = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: day(-10), due_date: day(0), lines: [{ description: "Catering", quantity: "1", unit_price: "5000", account_id: W.acc.SALES }] });
  await W.owner.post(W.c(`/documents/${d.json.id}/issue`));
  const token = (await W.owner.post(W.c("/verify"), { entity_type: "document", entity_id: d.json.id })).json.token as string;
  return { W, cust, inv: d.json.id as string, token };
}

const settings = (W: any, extra: Record<string, unknown> = {}) => W.owner.put(W.c("/collection"), {
  online_enabled: true, razorpay_key_id: "rzp_test_Abc123XYZ", razorpay_secret: SECRET, razorpay_webhook_secret: HOOK, deposit_account_id: W.acc.BANK,
  reminders_enabled: false, remind_before_days: 3, remind_on_due: true, remind_every_days: 7, remind_max_after: 3, ...extra,
});

describe("customers pay invoices online", () => {
  it("stores the business's Razorpay keys encrypted, never shows them, and refuses without DATA_KEY", async () => {
    const S = await shop();
    const calls = mockRazorpay();
    delete (S.W.env as any).DATA_KEY;
    expect((await settings(S.W)).json.error.code).toBe("DATA_KEY_MISSING");
    (S.W.env as any).DATA_KEY = "a-long-random-data-key-for-tests";
    expect((await settings(S.W)).status).toBe(200);
    expect(calls[0].auth).toBe(`Basic ${btoa(`rzp_test_Abc123XYZ:${SECRET}`)}`); // keys checked with Razorpay
    const got = (await S.W.owner.get(S.W.c("/collection"))).json;
    expect(got).toMatchObject({ online_enabled: true, has_secret: true, has_webhook_secret: true, ready: true });
    expect(JSON.stringify(got)).not.toContain(SECRET);
    const row = (await rawQuery(S.W, `SELECT razorpay_secret_enc FROM collection_settings`))[0];
    expect(row.razorpay_secret_enc).toMatch(/^v1\./);
    expect(row.razorpay_secret_enc).not.toContain(SECRET);
    expect(JSON.stringify(await rawQuery(S.W, `SELECT details FROM audit_logs WHERE action = 'company.collection_settings'`))).not.toContain(SECRET);
  });

  it("takes the payment on the invoice link and records the receipt against the invoice, once", async () => {
    const S = await shop();
    const calls = mockRazorpay();
    await settings(S.W);
    const pub = new Client(S.W.env);
    expect((await pub.get(`/api/verify/${S.token}`)).json.online_pay).toBe(true);
    const order = await pub.post(`/api/pay/${S.token}/order`);
    expect(order.status, JSON.stringify(order.json)).toBe(200);
    expect(order.json).toMatchObject({ key_id: "rzp_test_Abc123XYZ", amount: 500_000, currency: "INR", prefill: { name: "Lakeside Cafe" } });
    expect(calls.find((x) => x.url === "https://api.razorpay.com/v1/orders").body).toMatchObject({ amount: 500_000, currency: "INR" });
    expect(JSON.stringify(order.json)).not.toContain(SECRET);

    const ok = { razorpay_order_id: order.json.order_id, razorpay_payment_id: "pay_ABC", razorpay_signature: sign(SECRET, `${order.json.order_id}|pay_ABC`) };
    expect((await pub.post(`/api/pay/${S.token}/confirm`, { ...ok, razorpay_signature: "bad" })).status).toBe(400);
    expect((await pub.post(`/api/pay/${S.token}/confirm`, ok)).json).toMatchObject({ ok: true, already: false });
    const inv = (await S.W.owner.get(S.W.c(`/documents/${S.inv}`))).json;
    expect(inv.document ?? inv).toMatchObject({ amount_settled: 500_000 });
    const pay = (await rawQuery(S.W, `SELECT account_id, amount, method, reference, created_by FROM payments WHERE direction = 'in'`));
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ account_id: S.W.acc.BANK, amount: 500_000, method: "online", reference: "Razorpay pay_ABC" });

    // Razorpay's webhook reports the same payment: nothing more is recorded. A forged webhook is refused.
    const evt = { event: "payment.captured", payload: { payment: { entity: { id: "pay_ABC", order_id: order.json.order_id, status: "captured" } } } };
    const hook = (body: any, sig: string) => pub.req("POST", `/api/pay/webhook/${S.W.companyId}`, body, { "x-razorpay-signature": sig, "x-requested-with": "" });
    expect((await hook(evt, "forged")).status).toBe(401);
    expect((await hook(evt, sign(HOOK, JSON.stringify(evt)))).status).toBe(200);
    expect(await rawQuery(S.W, `SELECT id FROM payments WHERE direction = 'in'`)).toHaveLength(1);
    // Paid: no more orders.
    expect((await pub.post(`/api/pay/${S.token}/order`)).json.error.code).toBe("ALREADY_PAID");
  });

  it("records a payment that only the webhook reported (the customer closed the page)", async () => {
    const S = await shop();
    mockRazorpay();
    await settings(S.W);
    const pub = new Client(S.W.env);
    const order = (await pub.post(`/api/pay/${S.token}/order`)).json;
    const evt = { event: "order.paid", payload: { payment: { entity: { id: "pay_LATE", order_id: order.order_id } } } };
    await pub.req("POST", `/api/pay/webhook/${S.W.companyId}`, evt, { "x-razorpay-signature": sign(HOOK, JSON.stringify(evt)), "x-requested-with": "" });
    expect((await rawQuery(S.W, `SELECT amount_settled FROM documents WHERE id = ?`, S.inv))[0].amount_settled).toBe(500_000);
  });
});

describe("customer portal", () => {
  it("shows the customer their invoices, what is due and their receipts, and lets them accept a quotation", async () => {
    const S = await shop();
    const q = await S.W.owner.post(S.W.c("/documents"), { doc_type: "quote", contact_id: S.cust, issue_date: day(-1), lines: [{ description: "Party order", quantity: "1", unit_price: "8000", account_id: S.W.acc.SALES }] });
    await S.W.owner.post(S.W.c(`/documents/${q.json.id}/issue`));
    const link = (await S.W.owner.post(S.W.c(`/collection/portal/${S.cust}`), {})).json;
    expect(link.url).toMatch(/\/portal\/[A-Za-z0-9_-]{24,}$/);
    const pub = new Client(S.W.env);
    const p = (await pub.get(`/api/portal/${link.token}`)).json;
    expect(p.customer.name).toBe("Lakeside Cafe");
    expect(p.summary).toMatchObject({ outstanding: 500_000, overdue: 0, currency: "INR" });
    expect(p.invoices[0]).toMatchObject({ id: S.inv, total: 500_000, link: `/verify/${S.token}` });
    expect(p.quotes[0]).toMatchObject({ id: q.json.id, status: "open" });
    expect((await pub.post(`/api/portal/${link.token}/quotes/${q.json.id}/accept`)).json.status).toBe("accepted");
    expect((await pub.post(`/api/portal/${link.token}/quotes/${q.json.id}/decline`)).status).toBe(409);
    // Another customer's link cannot touch this quotation; a renewed link replaces the old one.
    const other = await contact(S.W, "customer", { name: "Other" });
    const otherLink = (await S.W.owner.post(S.W.c(`/collection/portal/${other}`), {})).json;
    expect((await pub.post(`/api/portal/${otherLink.token}/quotes/${q.json.id}/accept`)).status).toBe(404);
    const renewed = (await S.W.owner.post(S.W.c(`/collection/portal/${S.cust}`), { renew: true })).json;
    expect(renewed.token).not.toBe(link.token);
    expect((await pub.get(`/api/portal/${link.token}`)).status).toBe(404);
  });
});

describe("automatic payment reminders", () => {
  it("picks the right reminder for each day", () => {
    const s = { remind_before_days: 3, remind_on_due: 1, remind_every_days: 7, remind_max_after: 2 };
    expect(reminderKind(s, "2026-06-10", "2026-06-07")).toBe("before");
    expect(reminderKind(s, "2026-06-10", "2026-06-08")).toBeNull();
    expect(reminderKind(s, "2026-06-10", "2026-06-10")).toBe("due");
    expect(reminderKind(s, "2026-06-10", "2026-06-17")).toBe("after1");
    expect(reminderKind(s, "2026-06-10", "2026-06-24")).toBe("after2");
    expect(reminderKind(s, "2026-06-10", "2026-07-01")).toBeNull(); // after the 2nd overdue reminder: stop
  });

  it("emails the customer on the due date with the pay link, once", async () => {
    const S = await shop();
    const calls = mockRazorpay();
    Object.assign(S.W.env, { RESEND_API_KEY: "re_test", EMAIL_FROM: "LedgerFox <billing@example.com>" });
    expect((await settings(S.W, { reminders_enabled: true })).status).toBe(200);
    expect(await sendPaymentReminders(S.W.env)).toBe(1);
    const mail = calls.filter((x) => x.url === "https://api.resend.com/emails");
    expect(mail[0].body).toMatchObject({ to: ["accounts@lakeside.example"], subject: expect.stringMatching(/^Reminder: invoice INV-/) });
    expect(mail[0].body.text).toContain(`/verify/${S.token}`);
    expect(await sendPaymentReminders(S.W.env)).toBe(0);
  });
});
