import { describe, expect, it } from "vitest";
import { world, register } from "./helpers";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("CRM", () => {
  it("moves a lead through the pipeline with follow-ups, and turns it into a customer and a quotation", async () => {
    const W = await world();
    expect((await W.owner.post(W.c("/crm/leads"), { title: "No contact" })).status).toBe(400);
    const l = await W.owner.post(W.c("/crm/leads"), { title: "Website for clinic", person: "Dr. Rao", organisation: "Rao Dental Clinic", phone: "9845000001", source: "Instagram", value: "45000", expected_close: day(20) });
    expect(l.status, JSON.stringify(l.json)).toBe(201);
    await W.owner.post(W.c("/crm/leads"), { title: "SEO", person: "Anil", source: "Referral", value: "10000" });
    // A planned call is a follow-up until done; doing it moves a new lead to "contacted".
    const task = await W.owner.post(W.c(`/crm/leads/${l.json.id}/activities`), { kind: "call", summary: "Call to discuss pages", due_date: day(-1) });
    const fu = (await W.owner.get(W.c("/crm/follow-ups"))).json.follow_ups;
    expect(fu).toHaveLength(1);
    expect(fu[0]).toMatchObject({ title: "Website for clinic", phone: "9845000001" });
    expect((await W.owner.post(W.c(`/crm/activities/${task.json.id}/done`), { outcome: "Wants 6 pages" })).status).toBe(200);
    expect((await W.owner.get(W.c("/crm/follow-ups"))).json.follow_ups).toHaveLength(0);
    let d = (await W.owner.get(W.c(`/crm/leads/${l.json.id}`))).json;
    expect(d.lead.stage).toBe("contacted");
    expect(d.activities[0].summary).toBe("Call to discuss pages — Wants 6 pages");
    expect((await W.owner.patch(W.c(`/crm/leads/${l.json.id}`), { stage: "qualified", value: "50000" })).status).toBe(200);
    // Convert: a new customer and a draft quotation for the lead's value.
    const conv = await W.owner.post(W.c(`/crm/leads/${l.json.id}/convert`), { quotation: true });
    expect(conv.status, JSON.stringify(conv.json)).toBe(200);
    const q = (await W.owner.get(W.c(`/documents/${conv.json.quote_id}`))).json;
    expect(q.document).toMatchObject({ doc_type: "quote", status: "draft", contact_id: conv.json.contact_id, subtotal: 5_000_000 });
    expect((await W.owner.get(W.c(`/contacts/${conv.json.contact_id}`))).json.contact).toMatchObject({ name: "Rao Dental Clinic", phone: "9845000001", kind: "customer" });
    d = (await W.owner.get(W.c(`/crm/leads/${l.json.id}`))).json;
    expect(d.lead).toMatchObject({ stage: "proposal", quote_number: null, quote_status: "draft", customer: "Rao Dental Clinic" });
    // Converting again does not make a second customer or quotation.
    expect((await W.owner.post(W.c(`/crm/leads/${l.json.id}/convert`), { quotation: true })).json).toEqual(conv.json);
    // Won and lost; lost needs a reason.
    expect((await W.owner.patch(W.c(`/crm/leads/${l.json.id}`), { stage: "won" })).status).toBe(200);
    const list = (await W.owner.get(W.c("/crm/leads"))).json;
    const other = list.leads.find((x: any) => x.title === "SEO");
    expect((await W.owner.patch(W.c(`/crm/leads/${other.id}`), { stage: "lost" })).status).toBe(400);
    expect((await W.owner.patch(W.c(`/crm/leads/${other.id}`), { stage: "lost", lost_reason: "Price too high" })).status).toBe(200);
    const after = (await W.owner.get(W.c("/crm/leads"))).json;
    expect(after.pipeline.find((p: any) => p.stage === "won")).toMatchObject({ count: 1, value: 5_000_000 });
    expect(after.win_rate).toBe(0.5);
    const rep = (await W.owner.get(W.c("/crm/report?from=2000-01-01"))).json;
    expect(rep.by_source.find((s: any) => s.source === "Instagram")).toMatchObject({ leads: 1, won: 1, won_value: 5_000_000 });
    expect(rep.lost_reasons[0]).toMatchObject({ lost_reason: "Price too high", n: 1 });
    expect((await W.owner.get(W.c("/crm/leads?q=clinic"))).json.leads).toHaveLength(1);
    // Someone from another organisation sees nothing.
    const { client } = await register(W.env, "Stranger");
    expect((await client.get(W.c("/crm/leads"))).status).toBe(404);
  });
});
