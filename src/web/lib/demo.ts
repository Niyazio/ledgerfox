/**
 * Builds a demo company through the normal API (every record goes through the same validation and posting rules as
 * real data). Demo companies are flagged so they can be deleted in one step later.
 */
import { api } from "./api";
import { businessType } from "@shared/industries";

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function createDemoCompany(orgId: string | null, type: string, onProgress?: (step: string) => void): Promise<string> {
  const biz = businessType(type);
  const step = (s: string) => onProgress?.(s);
  step("Creating company");
  const NAMES: Record<string, string> = { retail: "FreshMart Supermarket", restaurant: "Spice Garden Restaurant", software: "CodeCraft Technologies", education: "Green Valley Public School",
    healthcare: "CareWell Clinic", manufacturing: "Precision Components", wholesale: "Metro Distributors", construction: "Skyline Builders", hotel: "Lakeview Residency",
    services: "Kumar & Associates", ngo: "Hope Foundation", transport: "Swift Logistics", general: "Sample Traders" };
  const demoName = NAMES[biz.key] ?? "Sample Traders";
  const company = { name: `${demoName} (demo)`, legal_name: `${demoName} Pvt Ltd`, country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29",
    tax_id: null, address: "12, MG Road", city: "Bengaluru", postal_code: "560001", phone: "+91 80 4000 0000", email: null, business_type: biz.key, is_demo: true };
  const created = orgId
    ? await api.post<{ company_id: string }>(`/api/orgs/${orgId}/companies`, company)
    : await api.post<{ company_id: string }>("/api/orgs", { name: "Demo organisation", company });
  const id = created.company_id;
  const p = (s: string) => `/api/c/${id}${s}`;

  const [accRes, settings, itemsRes] = await Promise.all([
    api.get<{ accounts: any[] }>(p("/accounts")),
    api.get<any>(p("/settings")),
    api.get<{ items: any[] }>(p("/items?limit=50")),
  ]);
  const acc: Record<string, string> = {};
  for (const a of accRes.accounts) { if (a.system_key) acc[a.system_key] = a.id; acc[a.code] = a.id; }
  const gst18 = settings.tax_codes.find((t: any) => t.name === "GST 18%")?.id ?? null;

  // Dates inside the current financial year, spread over the last few weeks.
  const fyStart = settings.company.fiscal_year_start_month;
  const now = new Date();
  const fyBegin = new Date(Date.UTC(now.getUTCMonth() + 1 >= fyStart ? now.getUTCFullYear() : now.getUTCFullYear() - 1, fyStart - 1, 1));
  const daysAgo = (n: number) => { const d = new Date(now.getTime() - n * 86400_000); return iso(d < fyBegin ? fyBegin : d); };

  step("Opening balances");
  await api.post(p("/journals"), {
    entry_date: daysAgo(40), kind: "opening", memo: "Opening balances (demo)", post: true,
    lines: [{ account_id: acc.BANK, debit: "500000" }, { account_id: acc.CASH, debit: "25000" }, { account_id: acc.CAPITAL, credit: "525000" }],
  });

  step("Customers and suppliers");
  const mk = (body: any) => api.post<{ id: string }>(p("/contacts"), { payment_terms_days: 15, country: "IN", ...body }).then((r) => r.id);
  const customers = await Promise.all([
    mk({ kind: "customer", name: "Sharma Enterprises", state_code: "29", phone: "+91 98450 11111", email: "accounts@sharma.example" }),
    mk({ kind: "customer", name: "Mumbai Retail Co", state_code: "27", phone: "+91 98200 22222" }),
    mk({ kind: "customer", name: "Walk-in customer", state_code: "29" }),
  ]);
  const suppliers = await Promise.all([
    mk({ kind: "supplier", name: "Karnataka Wholesale Suppliers", state_code: "29" }),
    mk({ kind: "supplier", name: "Chennai Distributors", state_code: "33" }),
  ]);

  step("Invoices");
  const items = itemsRes.items;
  const line = (i: number, qty: string) => {
    const it = items[i % Math.max(1, items.length)];
    return it
      ? { item_id: it.id, description: it.name, hsn_sac: it.hsn_sac, quantity: qty, unit_price: (it.sale_price / 100).toFixed(2), tax_code_id: it.tax_code_id, account_id: it.income_account_id }
      : { description: "Consulting services", quantity: qty, unit_price: "2500.00", tax_code_id: gst18 };
  };
  const invoices: { id: string; total: number }[] = [];
  const invSpec: [number, number, string[]][] = [[0, 30, ["2", "1"]], [1, 20, ["5"]], [2, 10, ["1", "3"]], [0, 3, ["4"]]];
  for (const [ci, ago, qtys] of invSpec) {
    // Goods with stock tracking need stock first, so demo invoices use untracked lines where needed.
    const lines = qtys.map((q, k) => { const l: any = line(ci + k, q); const it = items.find((x) => x.id === l.item_id); if (it?.track_inventory) { delete l.item_id; } return l; });
    const doc = await api.post<{ id: string }>(p("/documents"), { doc_type: "invoice", contact_id: customers[ci], issue_date: daysAgo(ago), due_date: daysAgo(ago - 15), lines, notes: "Thank you for your business." });
    await api.post(p(`/documents/${doc.id}/issue`));
    const full = await api.get<any>(p(`/documents/${doc.id}`));
    invoices.push({ id: doc.id, total: full.document.total });
  }
  await api.post(p("/documents"), { doc_type: "quote", contact_id: customers[1], issue_date: daysAgo(2), lines: [line(1, "10")] });

  step("Receipts");
  await api.post(p("/payments"), { direction: "in", contact_id: customers[0], payment_date: daysAgo(20), account_id: acc.BANK, amount: (invoices[0].total / 100).toFixed(2), method: "upi", reference: "UPI-DEMO-001",
    allocations: [{ document_id: invoices[0].id, amount: (invoices[0].total / 100).toFixed(2) }] });
  const half = Math.floor(invoices[1].total / 2);
  await api.post(p("/payments"), { direction: "in", contact_id: customers[1], payment_date: daysAgo(8), account_id: acc.BANK, amount: (half / 100).toFixed(2), method: "bank_transfer", reference: "NEFT-DEMO",
    allocations: [{ document_id: invoices[1].id, amount: (half / 100).toFixed(2) }] });

  step("Bills and expenses");
  const purchaseAcc = acc.PURCHASES ?? acc["5200"];
  for (const [si, ago, amount] of [[0, 25, "45000"], [1, 12, "18000"]] as [number, number, string][]) {
    const bill = await api.post<{ id: string }>(p("/documents"), { doc_type: "bill", contact_id: suppliers[si], issue_date: daysAgo(ago), due_date: daysAgo(ago - 30), reference: `SUP-${ago}`,
      lines: [{ description: "Stock purchase", quantity: "1", unit_price: amount, tax_code_id: gst18, account_id: purchaseAcc }] });
    await api.post(p(`/documents/${bill.id}/issue`));
  }
  const rent = acc["6200"], power = acc["6300"];
  for (const [account, desc, amount, ago] of [[rent, "Shop rent", "35000", 18], [power, "Electricity bill", "6200", 9]] as [string, string, string, number][]) {
    const e = await api.post<{ id: string }>(p("/expenses"), { expense_date: daysAgo(ago), category_account_id: account, paid_from_account_id: acc.BANK, description: desc, amount });
    await api.post(p(`/expenses/${e.id}/approve`));
  }

  step("Employees and payroll");
  await api.post(p("/payroll/employees"), { code: "E001", name: "Priya Nair", designation: "Store manager", pay_type: "monthly", monthly_basic: "18000", hra: "7200", other_allowances: "2000", pf_enabled: true, esi_enabled: false, pt_monthly: "200", date_of_joining: iso(fyBegin) });
  await api.post(p("/payroll/employees"), { code: "E002", name: "Arjun Kumar", designation: "Sales associate", pay_type: "monthly", monthly_basic: "11000", hra: "3500", pf_enabled: true, esi_enabled: true, pt_monthly: "150", date_of_joining: iso(fyBegin) });
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  if (lastMonth >= fyBegin) {
    const period = iso(lastMonth).slice(0, 7);
    const lastDay = iso(new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 0)));
    const run = await api.post<{ id: string }>(p("/payroll/runs"), { period, pay_date: lastDay });
    await api.post(p(`/payroll/runs/${run.id}/post`));
    await api.post(p(`/payroll/runs/${run.id}/pay`), { account_id: acc.BANK, date: lastDay });
  }
  step("Done");
  return id;
}
