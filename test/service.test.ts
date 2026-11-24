import { describe, expect, it } from "vitest";
import { world, contact, Client } from "./helpers";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("service desk", () => {
  it("tracks a ticket with a due date by priority, time spent, resolution, and bills the time", async () => {
    const W = await world();
    const cust = await contact(W, "customer", { name: "Green Café" });
    const t = await W.owner.post(W.c("/service/tickets"), { contact_id: cust, subject: "Billing printer not working", priority: "high", asset: "TVS RP3160, S/N 7781" });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    expect(t.json.number).toBe("TKT-0001");
    let d = (await W.owner.get(W.c(`/service/tickets/${t.json.id}`))).json;
    expect(d.ticket).toMatchObject({ status: "open", due_date: day(1), contract_id: null });
    await W.owner.post(W.c(`/service/tickets/${t.json.id}/notes`), { note: "Replaced roller", minutes: 90 });
    await W.owner.post(W.c(`/service/tickets/${t.json.id}/notes`), { note: "We will visit tomorrow", public: true });
    expect((await W.owner.patch(W.c(`/service/tickets/${t.json.id}`), { status: "resolved" })).status).toBe(400);
    expect((await W.owner.patch(W.c(`/service/tickets/${t.json.id}`), { status: "resolved", resolution: "Roller replaced, tested" })).status).toBe(200);
    const list = (await W.owner.get(W.c("/service/tickets?status=all"))).json;
    expect(list.tickets[0]).toMatchObject({ number: "TKT-0001", minutes: 90, status: "resolved" });
    const inv = await W.owner.post(W.c(`/service/tickets/${t.json.id}/invoice`), { hourly_rate: "600", lines: [{ description: "Printer roller", quantity: "1", unit_price: "450" }] });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    expect((await W.owner.get(W.c(`/documents/${inv.json.id}`))).json.document).toMatchObject({ status: "draft", subtotal: 135_000, reference: "TKT-0001" }); // 1.5 h × 600 + 450
    expect((await W.owner.post(W.c(`/service/tickets/${t.json.id}/invoice`), { hourly_rate: "600" })).status).toBe(409);
    d = (await W.owner.get(W.c(`/service/tickets/${t.json.id}`))).json;
    expect(d.notes).toHaveLength(2);
  });

  it("bills an AMC period by period, renews it, links tickets to it, and lets the customer raise a ticket from the portal", async () => {
    const W = await world();
    const cust = await contact(W, "customer", { name: "Kumar Motors" });
    const k = await W.owner.post(W.c("/service/contracts"), { contact_id: cust, title: "Computer AMC", start_date: day(-40), end_date: day(-40 + 364), billing: "quarterly", amount: "9000", visits_included: 4 });
    expect(k.status, JSON.stringify(k.json)).toBe(201);
    let list = (await W.owner.get(W.c("/service/contracts"))).json.contracts;
    expect(list[0]).toMatchObject({ number: "AMC-0001", state: "active", to_bill: true });
    const i1 = await W.owner.post(W.c(`/service/contracts/${k.json.id}/invoice`));
    expect(i1.status, JSON.stringify(i1.json)).toBe(201);
    expect(i1.json.from).toBe(day(-40));
    const i2 = (await W.owner.post(W.c(`/service/contracts/${k.json.id}/invoice`))).json;
    expect(i2.from > i1.json.to).toBe(true);
    expect((await W.owner.get(W.c(`/documents/${i1.json.id}`))).json.document.subtotal).toBe(900_000);
    // A ticket opened while the contract runs is covered by it.
    const t = (await W.owner.post(W.c("/service/tickets"), { contact_id: cust, subject: "Laptop slow" })).json;
    expect(t.contract.number).toBe("AMC-0001");
    // The customer raises a ticket from their portal and sees the public replies.
    const link = (await W.owner.post(W.c(`/collection/portal/${cust}`), {})).json;
    const pub = new Client(W.env);
    const raised = await pub.post(`/api/portal/${link.token}/tickets`, { subject: "Wi-Fi not working", description: "Since morning", priority: "urgent" });
    expect(raised.status, JSON.stringify(raised.json)).toBe(201);
    const tickets = (await W.owner.get(W.c("/service/tickets"))).json.tickets;
    const fromPortal = tickets.find((x: any) => x.number === raised.json.number);
    expect(fromPortal).toMatchObject({ source: "portal", priority: "urgent", contract_number: "AMC-0001", due_date: day(0) });
    await W.owner.post(W.c(`/service/tickets/${fromPortal.id}/notes`), { note: "Router restarted, please check", public: true });
    await W.owner.post(W.c(`/service/tickets/${fromPortal.id}/notes`), { note: "Internal: router is old", public: false });
    const portal = (await pub.get(`/api/portal/${link.token}`)).json;
    const mine = portal.tickets.find((x: any) => x.number === raised.json.number);
    expect(mine.replies.map((r: any) => r.note)).toEqual(["Router restarted, please check"]);
    // Renew: next year from the day after the end; the old one is marked renewed.
    const r = await W.owner.post(W.c(`/service/contracts/${k.json.id}/renew`), { amount: "9500" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.start_date).toBe(day(-40 + 365));
    list = (await W.owner.get(W.c("/service/contracts"))).json.contracts;
    expect(list.find((x: any) => x.number === "AMC-0001").state).toBe("renewed");
    expect(list.find((x: any) => x.number === "AMC-0002")).toMatchObject({ state: "upcoming", amount: 950_000 });
  });
});
