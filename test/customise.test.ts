import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { world, contact, Client } from "./helpers";
import { scheduleDue, sendScheduledReports } from "../src/worker/services/customise";

afterEach(() => vi.restoreAllMocks());
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function mockOut(calls: any[] = []) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, raw: init?.body, body: init?.body ? JSON.parse(init.body) : null });
    if (String(url) === "https://api.resend.com/emails") return Response.json({ id: "mail" });
    if (String(url).startsWith("https://hooks.example.com/")) return new Response("ok", { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}
const withEmail = (W: any) => Object.assign(W.env, { RESEND_API_KEY: "re_test", EMAIL_FROM: "LedgerFox <x@example.com>", DATA_KEY: "a-long-random-data-key-for-tests" });

async function invoice(W: any, cust: string, amount: string) {
  const d = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: day(-1), lines: [{ description: "Service", quantity: "1", unit_price: amount, account_id: W.acc.SALES }] });
  expect((await W.owner.post(W.c(`/documents/${d.json.id}/issue`))).status).toBe(200);
  return d.json.id as string;
}

describe("custom fields", () => {
  it("adds fields to invoices and products, checks the values, and respects who may edit", async () => {
    const W = await world();
    const vehicle = (await W.owner.post(W.c("/custom-fields"), { entity: "sales", label: "Vehicle no.", field_type: "text" })).json.id;
    const mode = (await W.owner.post(W.c("/custom-fields"), { entity: "sales", label: "Delivery", field_type: "select", options: ["Pickup", "Courier"] })).json.id;
    expect((await W.owner.post(W.c("/custom-fields"), { entity: "sales", label: "Bad list", field_type: "select" })).status).toBe(400);
    const warranty = (await W.owner.post(W.c("/custom-fields"), { entity: "item", label: "Warranty (months)", field_type: "number" })).json.id;
    const cust = await contact(W, "customer");
    const inv = await invoice(W, cust, "1000");
    const put = await W.owner.put(W.c(`/custom-values/sales/${inv}`), { values: { [vehicle]: "KA01AB1234", [mode]: "Courier" } });
    expect(put.json.values.map((v: any) => [v.label, v.value])).toEqual([["Vehicle no.", "KA01AB1234"], ["Delivery", "Courier"]]);
    expect((await W.owner.put(W.c(`/custom-values/sales/${inv}`), { values: { [mode]: "Drone" } })).status).toBe(400);
    expect((await W.owner.put(W.c(`/custom-values/purchase/${inv}`), { values: {} })).status).toBe(404); // an invoice is not a purchase
    // Clearing a value removes it.
    expect((await W.owner.put(W.c(`/custom-values/sales/${inv}`), { values: { [mode]: "" } })).json.values).toHaveLength(1);

    const item = (await W.owner.post(W.c("/items"), { kind: "goods", name: "Fan", sale_price: "2000" })).json.id;
    expect((await W.owner.put(W.c(`/custom-values/item/${item}`), { values: { [warranty]: "12" } })).status).toBe(200);
    expect((await W.owner.put(W.c(`/custom-values/item/${item}`), { values: { [warranty]: "a year" } })).status).toBe(400);
    // A cashier sees the values but cannot change a product's.
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Cashier", username: "cf.cashier", role: "billing" });
    const cl = new Client(W.env);
    await cl.post("/api/auth/login", { login: "cf.cashier", password: u.json.temporary_password });
    await cl.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "cf cashier pass 1" });
    expect((await cl.get(W.c(`/custom-values/sales/${inv}`))).json.values[0].value).toBe("KA01AB1234");
    expect((await cl.put(W.c(`/custom-values/item/${item}`), { values: { [warranty]: "24" } })).status).toBe(403);
    expect((await cl.post(W.c("/custom-fields"), { entity: "item", label: "X", field_type: "text" })).status).toBe(403);
  });
});

describe("automation rules", () => {
  it("emails when a large invoice is issued, and calls a signed webhook when a payment arrives", async () => {
    const W = await world();
    withEmail(W);
    const calls = mockOut();
    const cust = await contact(W, "customer", { name: "Big Buyer" });
    await W.owner.post(W.c("/automations"), { name: "Big invoices", event: "invoice.issued", min_amount: "1000", action: "email", target: "boss@example.com" });
    const hook = (await W.owner.post(W.c("/automations"), { name: "To my CRM", event: "payment.received", action: "webhook", target: "https://hooks.example.com/ledgerfox" })).json;
    expect(hook.signing_secret).toMatch(/^whsec_/);
    expect((await W.owner.post(W.c("/automations"), { name: "x", event: "payment.received", action: "webhook", target: "http://hooks.example.com/" })).status).toBe(400);

    const small = await invoice(W, cust, "500");
    expect(calls.filter((x) => x.url.includes("resend"))).toHaveLength(0);
    const big = await invoice(W, cust, "5000");
    const mail = calls.filter((x) => x.url.includes("resend"));
    expect(mail).toHaveLength(1);
    expect(mail[0].body).toMatchObject({ to: ["boss@example.com"], subject: expect.stringMatching(/an invoice is issued — INV-/) });
    expect(mail[0].body.text).toContain("Big Buyer");

    await W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: day(0), account_id: W.acc.CASH, amount: "500", allocations: [{ document_id: small, amount: "500" }] });
    const sent = calls.filter((x) => x.url === "https://hooks.example.com/ledgerfox");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ event: "payment.received", data: { amount: 50_000, contact_name: "Big Buyer" } });
    // The receiver can check the signature with the secret it was given.
    expect(sent[0].headers["x-ledgerfox-signature"]).toBe(`sha256=${createHmac("sha256", hook.signing_secret).update(sent[0].raw).digest("hex")}`);
    const list = (await W.owner.get(W.c("/automations"))).json;
    expect(list.runs.map((r: any) => [r.event, r.ok])).toEqual(expect.arrayContaining([["invoice.issued", 1], ["payment.received", 1]]));
    expect(JSON.stringify(list)).not.toContain(hook.signing_secret);
    void big;

    // Switched off: nothing happens. "Test" still sends a sample.
    await W.owner.patch(W.c(`/automations/${hook.id}`), { is_active: false });
    await W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: day(0), account_id: W.acc.CASH, amount: "100" });
    expect(calls.filter((x) => x.url === "https://hooks.example.com/ledgerfox")).toHaveLength(1);
    expect((await W.owner.post(W.c(`/automations/${hook.id}/test`))).json.result).toMatchObject({ ok: 1, detail: "HTTP 200" });
  });
});

describe("reports by email", () => {
  it("knows when a schedule is due", () => {
    expect(scheduleDue({ frequency: "daily", weekday: 1, last_sent_on: null }, "2026-06-10")).toBe(true);
    expect(scheduleDue({ frequency: "daily", weekday: 1, last_sent_on: "2026-06-10" }, "2026-06-10")).toBe(false);
    expect(scheduleDue({ frequency: "weekly", weekday: 1, last_sent_on: null }, "2026-06-08")).toBe(true); // a Monday
    expect(scheduleDue({ frequency: "weekly", weekday: 1, last_sent_on: null }, "2026-06-09")).toBe(false);
    expect(scheduleDue({ frequency: "monthly", weekday: 1, last_sent_on: null }, "2026-07-01")).toBe(true);
  });

  it("emails the daily summary to the chosen people, once a day", async () => {
    const W = await world();
    withEmail(W);
    const calls = mockOut();
    const cust = await contact(W, "customer");
    await invoice(W, cust, "2500");
    expect((await W.owner.post(W.c("/report-schedules"), { report: "daily-summary", frequency: "daily", recipients: "owner@example.com, partner@example.com" })).status).toBe(201);
    expect((await W.owner.post(W.c("/report-schedules"), { report: "profit-loss", frequency: "daily", recipients: "not-an-email" })).status).toBe(400);
    expect(await sendScheduledReports(W.env)).toBe(2);
    const mail = calls.filter((x) => x.url.includes("resend"));
    expect(mail[0].body.subject).toMatch(/summary for/);
    expect(mail[0].body.text).toMatch(/Sales invoiced: ₹2,500\.00/);
    expect(await sendScheduledReports(W.env)).toBe(0);
  });
});
