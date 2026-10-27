import { describe, expect, it } from "vitest";
import { Client, world, contact } from "./helpers";
import { detectIntent, nameIn, parsePeriod } from "../src/worker/services/assistant";

describe("assistant: understanding the question", () => {
  const T = "2026-10-27"; // a Tuesday
  it("reads periods", () => {
    expect(parsePeriod("sales today", T)).toMatchObject({ from: T, to: T });
    expect(parsePeriod("sales yesterday", T)).toMatchObject({ from: "2026-10-26", to: "2026-10-26" });
    expect(parsePeriod("sales", T)).toMatchObject({ from: "2026-10-01", to: T, label: "this month" });
    expect(parsePeriod("profit last month", T)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(parsePeriod("sales this week", T)).toMatchObject({ from: "2026-10-26", to: T });
    expect(parsePeriod("sales last week", T)).toMatchObject({ from: "2026-10-19", to: "2026-10-25" });
    expect(parsePeriod("sales last 7 days", T)).toMatchObject({ from: "2026-10-21", to: T });
    expect(parsePeriod("sales in march", T)).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
    expect(parsePeriod("sales in december", T)).toMatchObject({ from: "2025-12-01", to: "2025-12-31" }); // the last December
    expect(parsePeriod("sales feb 2024", T)).toMatchObject({ from: "2024-02-01", to: "2024-02-29" });
    expect(parsePeriod("sales this year", T)).toMatchObject({ from: "2026-04-01", to: T });
    expect(parsePeriod("sales last year", T)).toMatchObject({ from: "2025-04-01", to: "2026-03-31" });
    expect(parsePeriod("sales from 2026-05-01 to 2026-05-15", T)).toMatchObject({ from: "2026-05-01", to: "2026-05-15" });
  });

  it("recognises the kind of question", () => {
    const cases: [string, string][] = [
      ["hi", "help"], ["How do I create an invoice?", "howto"], ["sales this month", "sales"], ["How much did we sell yesterday", "sales"],
      ["purchases last month", "purchases"], ["expenses in March", "expenses"], ["profit this year", "profit"], ["who owes me money?", "receivables"],
      ["what do I owe suppliers", "payables"], ["overdue invoices", "overdue"], ["top customers", "top_customers"], ["list customers", "customer_list"],
      ["show all suppliers", "supplier_list"], ["cash and bank balance", "cash"], ["GST payable this month", "gst"], ["low stock", "low_stock"],
      ["what is expiring", "expiring"], ["stock of paracetamol", "item_stock"], ["details of Ravi Traders", "contact"], ["Ravi Traders phone number", "contact"],
      ["blah blah", "unknown"],
    ];
    for (const [q, intent] of cases) expect(detectIntent(q), q).toBe(intent);
    expect(nameIn("details of Ravi Traders?")).toBe("ravi traders");
    expect(nameIn("Ravi Traders phone number")).toBe("ravi traders");
  });
});

describe("assistant: answers from the books", () => {
  it("answers with the company's figures, and only what the role allows", async () => {
    const W = await world();
    const ravi = await contact(W, "customer", { name: "Ravi Traders", phone: "9876543210" });
    const asha = await contact(W, "customer", { name: "Asha Stores" });
    const today = new Date().toISOString().slice(0, 10);
    const sell = async (cid: string, amount: string, date = today, due?: string) => {
      const d = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cid, issue_date: date, due_date: due, lines: [{ description: "Goods", quantity: "1", unit_price: amount }] });
      expect((await W.owner.post(W.c(`/documents/${d.json.id}/issue`))).status).toBe(200);
      return d.json.id as string;
    };
    await sell(ravi, "1500");
    await sell(asha, "500");
    await sell(ravi, "1000", "2026-04-10", "2026-04-20"); // old and overdue
    const ask = async (cl: Client, message: string) => (await cl.post(W.c("/assistant"), { message })).json;

    const sales = await ask(W.owner, "sales this month");
    expect(sales.text).toMatch(/₹2,000\.00 from 2 invoices/);
    expect(sales.table.rows[0]).toEqual(["Ravi Traders", "₹1,500.00"]);
    const owed = await ask(W.owner, "who owes me money?");
    expect(owed.text).toMatch(/customers owe you ₹3,000\.00/);
    expect(owed.table.rows[0]).toEqual(["Ravi Traders", "₹2,500.00", 2, "9876543210"]);
    const overdue = await ask(W.owner, "overdue invoices");
    expect(overdue.table.rows).toEqual([["Ravi Traders", "₹1,000.00", 1, "2026-04-20"]]);
    const det = await ask(W.owner, "details of ravi");
    expect(det.text).toBe("Ravi Traders:");
    expect(det.table.rows).toEqual(expect.arrayContaining([["Phone", "9876543210"], ["They owe you", "₹2,500.00"], ["Of which overdue", "₹1,000.00"]]));
    expect(det.links[0].to).toBe(`contacts/${ravi}`);
    expect((await ask(W.owner, "details of nobody here")).text).toMatch(/couldn't find/);
    expect((await ask(W.owner, "profit this year")).text).toMatch(/^Profit for this financial year/);
    expect((await ask(W.owner, "how do I record a receipt")).links[0].to).toBe("payments/in/new");
    expect((await ask(W.owner, "list customers")).text).toMatch(/2 active customers/);
    expect((await ask(W.owner, "xyz")).suggestions.length).toBeGreaterThan(3);

    // Billing staff: sales yes, company profit and cash no.
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Cashier", username: "ask.cashier", role: "billing" });
    const cl = new Client(W.env);
    await cl.post("/api/auth/login", { login: "ask.cashier", password: u.json.temporary_password });
    await cl.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "ask cashier pass 1" });
    expect((await ask(cl, "sales today")).text).toMatch(/₹2,000\.00/);
    expect((await ask(cl, "profit this month")).text).toMatch(/does not include reports/);
    expect((await ask(cl, "cash balance")).text).toMatch(/does not include/);
    expect((await ask(cl, "what do I owe suppliers")).text).toMatch(/does not include purchases/);
    // Validation.
    expect((await cl.post(W.c("/assistant"), { message: "" })).status).toBe(400);
  });
});
