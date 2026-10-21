import { describe, expect, it } from "vitest";
import { mailtoUrl, shareMessage, upiLink, waNumber, whatsappUrl } from "../src/shared/share";

describe("sharing helpers", () => {
  it("builds UPI and WhatsApp links", () => {
    expect(upiLink("rao@okbank", "Rao Traders", 58000, "Invoice INV-00001")).toBe("upi://pay?pa=rao%40okbank&pn=Rao%20Traders&am=580.00&cu=INR&tn=Invoice%20INV-00001");
    expect(waNumber("98450 00001")).toBe("919845000001");
    expect(waNumber("+91 98450-00001")).toBe("919845000001");
    expect(waNumber("09845000001")).toBe("919845000001");
    expect(waNumber("12345")).toBeNull();
    expect(whatsappUrl("Hi & bye", "9845000001")).toBe("https://wa.me/919845000001?text=Hi%20%26%20bye");
    expect(whatsappUrl("Hi")).toBe("https://wa.me/?text=Hi");
    expect(mailtoUrl("a@b.example", "Invoice 1", "Line 1\nLine 2")).toBe("mailto:a%40b.example?subject=Invoice%201&body=Line%201%0ALine%202");
  });

  it("writes invoice, reminder and receipt messages", () => {
    const base = { kind: "invoice" as const, number: "INV-00001", party: "Sharma Traders", company: "Rao Traders", date: "10-05-2026", dueDate: "25-05-2026", total: "₹1,180.00", balance: "₹580.00", link: "https://x/verify/abc", upiId: "rao@okbank" };
    const m = shareMessage(base);
    expect(m).toContain("Please find invoice INV-00001 dated 10-05-2026 for ₹1,180.00.");
    expect(m).toContain("Amount due: ₹580.00 by 25-05-2026.");
    expect(m).toContain("View and pay online: https://x/verify/abc");
    expect(m).toContain("UPI: rao@okbank");
    expect(shareMessage({ ...base, overdueDays: 3 }, true)).toContain("has ₹580.00 outstanding, due on 25-05-2026 (3 days overdue).");
    expect(shareMessage({ ...base, kind: "receipt", number: "RCPT-1", total: "₹600.00", balance: null, upiId: null })).toContain("Thank you. We have received ₹600.00 (receipt RCPT-1, 10-05-2026).");
  });
});

describe("customer link for a shared invoice", () => {
  it("shows the invoice with UPI payment details; bills only confirm they exist", async () => {
    const { world, contact, Client } = await import("./helpers");
    const W = await world();
    await W.owner.patch(W.c("/settings"), { name: "Acme Traders", state_code: "29", upi_id: "acme@okbank" });
    const cust = await contact(W, "customer", { state_code: "29" });
    const inv = await W.owner.post(W.c("/documents"), { doc_type: "invoice", contact_id: cust, issue_date: "2026-05-10", lines: [{ description: "Tea", quantity: "2", unit_price: "500", tax_code_id: W.tax["GST 18%"] }] });
    await W.owner.post(W.c(`/documents/${inv.json.id}/issue`));
    await W.owner.post(W.c("/payments"), { direction: "in", contact_id: cust, payment_date: "2026-05-11", account_id: W.acc.BANK, amount: "600", allocations: [{ document_id: inv.json.id, amount: "600" }] });
    // Billing staff (no reports access) can create the share link.
    const u = await W.owner.post(`/api/orgs/${W.orgId}/users`, { name: "Bill", username: "share.bill", role: "billing" });
    const bill = new Client(W.env);
    await bill.post("/api/auth/login", { login: "share.bill", password: u.json.temporary_password });
    await bill.post("/api/auth/change-password", { current_password: u.json.temporary_password, new_password: "share bill pass 1" });
    const tok = await bill.post(W.c("/verify"), { entity_type: "document", entity_id: inv.json.id });
    expect(tok.status).toBe(200);
    const pub = (await new Client(W.env).get(`/api/verify/${tok.json.token}`)).json;
    expect(pub).toMatchObject({ valid: true, kind: "Invoice", amount: 118_000, balance: 58_000, pay: { upi_id: "acme@okbank", amount: 58_000 } });
    expect(pub.lines).toEqual([expect.objectContaining({ description: "Tea", qty_milli: 2000, unit_price: 50_000, taxable: 100_000, cgst: 9000, sgst: 9000 })]);
    // A supplier bill shared for verification reveals no lines or payment details.
    const supp = await contact(W, "supplier");
    const b = await W.owner.post(W.c("/documents"), { doc_type: "bill", contact_id: supp, issue_date: "2026-05-10", lines: [{ description: "Secret purchase", quantity: "1", unit_price: "999" }] });
    await W.owner.post(W.c(`/documents/${b.json.id}/issue`));
    expect((await bill.post(W.c("/verify"), { entity_type: "document", entity_id: b.json.id })).status).toBe(403);
    const t2 = (await W.owner.post(W.c("/verify"), { entity_type: "document", entity_id: b.json.id })).json.token;
    const pb = (await new Client(W.env).get(`/api/verify/${t2}`)).json;
    expect(pb.lines).toBeUndefined();
    expect(pb.pay).toBeUndefined();
  });
});
