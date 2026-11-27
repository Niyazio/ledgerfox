/**
 * Builds the Foxlator user manual (public/manual/Foxlator-User-Manual.pdf):
 * fills a demo company on a LOCAL Foxlator, takes screenshots of each screen, and prints the chapters to PDF.
 *
 *   1. Start a local copy with a fresh database (never production):
 *        npx wrangler d1 migrations apply ledgerfox --local --persist-to .manual-db
 *        npx wrangler dev --local --persist-to .manual-db --port 8799     (with .dev.vars: APP_ENV=development, BILLING_REQUIRE_AUTOPAY=false)
 *   2. npm run build   (the local copy serves dist/)
 *   3. npx tsx scripts/manual/build.ts [http://localhost:8799]
 *      or, for the Microsoft Store screenshots (1920 × 1080 PNG):  … build.ts http://localhost:8799 --store <folder>
 *
 * Chrome: CHROME_PATH, or Playwright's own browser.
 */
import { chromium, type Page } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidGstin } from "../../src/shared/tax";
import { CHAPTERS, type Block } from "./content";

const B = process.argv[2] ?? "http://localhost:8799";
const STORE_DIR = process.argv.includes("--store") ? process.argv[process.argv.indexOf("--store") + 1] : null;
/** The screens shown on the Store listing, in order. */
const STORE_SHOTS = ["dashboard", "invoice-new", "gst", "crm", "tickets", "rfq", "inventory", "reports", "cheques", "match"];
const ROOT = join(import.meta.dirname, "..", "..");
const OUT = join(ROOT, "public", "manual", "Foxlator-User-Manual.pdf");
const day = (o: number) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
const gstin = (state: string, pan: string) => { for (const ch of "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") { const g = `${state}${pan}1Z${ch}`; if (isValidGstin(g)) return g; } throw new Error("gstin"); };

type Api = (method: string, path: string, body?: unknown) => Promise<any>;
const shots = new Map<string, string>(); // name → data URL

async function main() {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const ctx = await browser.newContext(STORE_DIR ? { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.25 });
  const page = await ctx.newPage();
  await page.goto(`${B}/login`);
  await page.waitForTimeout(1200);
  await snap(page, "login");
  const api: Api = async (method, path, body) => {
    const r = await page.evaluate(async ([m, p, b]) => {
      const res = await fetch(p as string, { method: m as string, headers: { "content-type": "application/json", "x-requested-with": "ledgerfox" }, body: b ? JSON.stringify(b) : undefined });
      return { status: res.status, json: await res.json().catch(() => null) };
    }, [method, path, body] as const);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const s = await seed(api);
  const go = async (path: string, name: string, after?: (p: Page) => Promise<void>, opts: { full?: boolean } = {}) => {
    await page.goto(`${B}/app/${s.id}/${path}`);
    await page.waitForTimeout(1600);
    if (after) { await after(page); await page.waitForTimeout(900); }
    await snap(page, name, opts.full);
  };
  const tab = (name: string) => async (p: Page) => { await p.getByRole("button", { name, exact: true }).or(p.getByRole("tab", { name, exact: true })).first().click(); };
  const click = (text: string) => async (p: Page) => { await p.getByText(text, { exact: false }).first().click(); };

  await go("dashboard", "dashboard");
  await go("settings", "settings");
  await go("settings?tab=features", "features");
  await go("settings?tab=members", "users");
  await go("customers", "customers");
  await go(`contacts/${s.customers.sharma}`, "customer");
  await go("sales/invoice/new", "invoice-new");
  await go(`sales/invoice/${s.invoice}`, "invoice");
  await page.goto(`${B}/print/${s.id}/document/${s.invoice}`); await page.waitForTimeout(2200); await snap(page, "invoice-print");
  await go("sales/quote", "quotes");
  await go("payments/in/new", "receipt-new");
  await go("pos", "pos");
  await go("recurring", "recurring");
  await go("suppliers", "suppliers");
  await go(`purchases/bill/${s.bill}`, "bill");
  await go("expenses", "expenses");
  await go("inventory", "inventory");
  await go(`inventory/${s.items.laptop}`, "product");
  await go("banking", "banking");
  await go("cheques", "cheques");
  await go("cheques", "interest", tab("Interest on overdue"));
  await page.goto(`${B}/print-cheque/${s.id}/${s.chequeOut}`); await page.waitForTimeout(1500); await snap(page, "cheque-print");
  await go("journals", "journals");
  await go("accounts", "accounts");
  await go("daybook", "daybook");
  await go("reports", "reports");
  await go("reports/profit-loss", "profit-loss");
  await go("reports/balance-sheet", "balance-sheet");
  await go("reports/gst-returns", "gst");
  await go("reports/tax-check", "tax-check");
  await go("reports/audit-checks", "audit-checks");
  await go("crm", "crm");
  await go("crm", "lead", click("Website for dental clinic"));
  await go("crm", "followups", tab("Follow-ups"));
  await go("service", "tickets");
  await go("service", "ticket", click("Billing printer not working"));
  await go("service", "contracts", tab("AMC / service contracts"));
  await go("purchasing", "rfq", click("RFQ-0001"));
  await go("purchasing", "grn", tab("Goods receipts (GRN)"));
  await go("purchasing", "match", async (p) => { await tab("3-way match")(p); await p.waitForTimeout(900); await p.getByText(/^PO-/).first().click(); });
  await go("purchasing", "landed", tab("Landed cost"));
  await go("approvals", "approvals");
  await go("fx-revaluation", "fx");
  await go("api-keys", "api-keys");
  await go("import", "import");
  // On a phone: the customer's and the supplier's portal, and the app.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const pp = await phone.newPage();
  await pp.goto(`${B}/portal/${s.portal.customer}`); await pp.waitForTimeout(1800); await snap(pp, "portal-customer", true);
  await pp.goto(`${B}/portal/${s.portal.supplier}`); await pp.waitForTimeout(1800); await snap(pp, "portal-supplier", true);
  await browser.close();
  if (!STORE_DIR) await pdf();
}

async function snap(page: Page, name: string, full = false) {
  if (STORE_DIR) {
    const n = STORE_SHOTS.indexOf(name);
    if (n >= 0) { mkdirSync(STORE_DIR, { recursive: true }); await page.screenshot({ path: join(STORE_DIR, `${String(n + 1).padStart(2, "0")}-${name}.png`) }); console.log("store", name); }
    return;
  }
  const buf = await page.screenshot({ type: "jpeg", quality: 72, fullPage: full, ...(full ? {} : { clip: { x: 0, y: 0, width: page.viewportSize()!.width, height: page.viewportSize()!.height } }) });
  shots.set(name, `data:image/jpeg;base64,${buf.toString("base64")}`);
  console.log("shot", name, Math.round(buf.length / 1024), "KB");
}

/** A small but complete business: services agency with some goods, a quarter of activity. */
async function seed(api: Api) {
  await api("POST", "/api/auth/register", { name: "Niyaz (Owner)", email: `manual${Date.now()}@example.com`, password: "correct horse battery", accept_terms: true });
  const org = await api("POST", "/api/orgs", { name: "MNC Global Group", company: { name: "MNCG Digital & Creative Solutions", country: "IN", base_currency: "INR", fiscal_year_start_month: 4, state_code: "29", business_type: "services" } });
  const id = org.company_id as string;
  const c = (p: string) => `/api/c/${id}${p}`;
  await api("PATCH", c("/settings"), { name: "MNCG Digital & Creative Solutions", legal_name: "MNCG Digital & Creative Solutions", tax_id: gstin("29", "ABCDE1234F"), address: "2nd Floor, 14 MG Road", city: "Bengaluru", postal_code: "560001", phone: "080 4000 1234", email: "accounts@mncg.example" });
  await api("PUT", c("/settings/modules"), { off: [] });
  const accs = (await api("GET", c("/accounts"))).accounts as any[];
  const acc = Object.fromEntries(accs.flatMap((a) => [[a.code, a.id], ...(a.system_key ? [[a.system_key, a.id]] : [])]));
  const tax = Object.fromEntries(((await api("GET", c("/settings"))).tax_codes as any[]).map((t) => [t.name, t.id]));
  const gst18 = Object.entries(tax).find(([n]) => /18/.test(n))?.[1];
  const contact = async (b: Record<string, unknown>) => (await api("POST", c("/contacts"), { payment_terms_days: 15, ...b })).id as string;
  const customers = {
    sharma: await contact({ kind: "customer", name: "Sharma Traders", tax_id: gstin("29", "AAQFS1234K"), state_code: "29", phone: "9845000001", email: "accounts@sharma.example", billing_address: "45 Commercial Street, Bengaluru" }),
    rao: await contact({ kind: "customer", name: "Rao Dental Clinic", state_code: "29", phone: "9845000002" }),
    kumar: await contact({ kind: "customer", name: "Kumar Motors", tax_id: gstin("27", "AAKFK5678M"), state_code: "27", phone: "9820000003" }),
    cafe: await contact({ kind: "customer", name: "Green Café", state_code: "29", phone: "9845000004" }),
    us: await contact({ kind: "customer", name: "Bright Media LLC", country: "US", currency: "USD", state_code: "96" }),
  };
  const suppliers = {
    alpha: await contact({ kind: "supplier", name: "Alpha Computers", tax_id: gstin("29", "AAJFA2345B"), state_code: "29" }),
    beta: await contact({ kind: "supplier", name: "Beta IT Solutions", state_code: "29" }),
    print: await contact({ kind: "supplier", name: "Quick Print House", state_code: "29" }),
  };
  await api("POST", c("/import/items"), { rows: [
    { Name: "Website Design", Type: "Service", SKU: "MNCG-WEB-001", HSN: "998314", "GST %": "18", "Selling Price": "25000", Description: "Five-page responsive website with contact form" },
    { Name: "Social Media Management", Type: "Service", SKU: "MNCG-DM-001", HSN: "998361", "GST %": "18", "Selling Price": "₹8,000/month", Description: "Content planning, posting and monthly report" },
    { Name: "Logo Design", Type: "Service", SKU: "MNCG-GFX-001", HSN: "998391", "GST %": "18", "Selling Price": "2000", Description: "Three concepts, two revisions" },
    { Name: "IT Consultation", Type: "Service", SKU: "MNCG-IT-009", HSN: "998313", "GST %": "18", "Selling Price": "₹1,000/hour" },
    { Name: "Laptop i5 16GB", Type: "Goods", SKU: "HW-LAP-01", HSN: "8471", "GST %": "18", Unit: "nos", "Selling Price": "62000", "Purchase Price": "54000", "Opening Stock": "6", "Reorder Level": "2" },
    { Name: "Wireless mouse", Type: "Goods", SKU: "HW-MOU-01", HSN: "8471", "GST %": "18", Unit: "nos", "Selling Price": "900", "Purchase Price": "550", "Opening Stock": "40", "Reorder Level": "10" },
  ], as_of: day(-90) });
  const all = (await api("GET", c("/items?limit=100"))).items as any[];
  const items = Object.fromEntries(all.map((i) => [i.sku, i.id]));
  const names = Object.fromEntries(all.map((i) => [i.sku, i.name]));
  const line = (sku: string, qty: string, price?: string) => ({ item_id: items[sku], description: names[sku], quantity: qty, ...(price ? { unit_price: price } : {}), tax_code_id: gst18 });
  const doc = async (b: Record<string, unknown>, issue = true) => { const d = await api("POST", c("/documents"), b); if (issue) await api("POST", c(`/documents/${d.id}/issue`)); return d.id as string; };
  const invoice = await doc({ doc_type: "invoice", contact_id: customers.sharma, issue_date: day(-35), due_date: day(-20), lines: [line("MNCG-WEB-001", "1", "25000"), line("MNCG-GFX-001", "1", "2000")] });
  const inv2 = await doc({ doc_type: "invoice", contact_id: customers.kumar, issue_date: day(-28), lines: [line("HW-LAP-01", "2", "62000"), line("HW-MOU-01", "2", "900")] });
  await doc({ doc_type: "invoice", contact_id: customers.cafe, issue_date: day(-12), lines: [line("MNCG-DM-001", "1", "8000")] });
  await doc({ doc_type: "invoice", contact_id: customers.rao, issue_date: day(-4), lines: [line("MNCG-IT-009", "3", "1000")] });
  await doc({ doc_type: "invoice", contact_id: customers.us, issue_date: day(-20), currency: "USD", fx_rate: "83", lines: [{ description: "Promotional video", quantity: "1", unit_price: "2500", account_id: acc.SALES }] });
  await doc({ doc_type: "quote", contact_id: customers.rao, issue_date: day(-2), lines: [line("MNCG-WEB-001", "1", "45000")] });
  await api("POST", c("/payments"), { direction: "in", contact_id: customers.kumar, payment_date: day(-15), account_id: acc.BANK ?? acc["1121"], amount: "126160", method: "bank_transfer", reference: "NEFT 77812", allocations: [{ document_id: inv2, amount: "126160" }] }).catch(() => undefined);
  const bill = await doc({ doc_type: "bill", contact_id: suppliers.alpha, issue_date: day(-30), reference: "AC/2291", lines: [line("HW-LAP-01", "4", "54000")] });
  await doc({ doc_type: "bill", contact_id: suppliers.print, issue_date: day(-9), reference: "QP-118", lines: [{ description: "Brochure printing", quantity: "500", unit_price: "12", account_id: acc.PURCHASES }] });
  await api("POST", c("/expenses"), { expense_date: day(-6), description: "Office internet — November", amount: "1999", paid_from_account_id: acc.BANK ?? acc["1121"], account_id: acc["6600"] }).catch(() => undefined);
  // Cheques, interest, CRM, service desk, purchasing, approvals, currency, API.
  await api("POST", c("/cheques"), { direction: "in", contact_id: customers.sharma, cheque_no: "004512", bank_name: "HDFC Bank", cheque_date: day(12), amount: "27000", allocations: [] });
  const chequeOut = (await api("POST", c("/cheques"), { direction: "out", contact_id: suppliers.print, cheque_no: "500107", cheque_date: day(0), amount: "7080", account_id: acc.BANK ?? acc["1121"], payee_name: "Quick Print House" })).id;
  const lead = async (b: Record<string, unknown>) => (await api("POST", c("/crm/leads"), b)).id as string;
  const l1 = await lead({ title: "Website for dental clinic", person: "Dr. Rao", organisation: "Rao Dental Clinic", phone: "9845000002", source: "Instagram", value: "45000", expected_close: day(20) });
  await lead({ title: "SEO for 6 months", person: "Anil Kumar", organisation: "Kumar Motors", source: "Referral", value: "60000", stage: "qualified" });
  await lead({ title: "Brand identity kit", person: "Priya", source: "Website", value: "8000", stage: "proposal" });
  await lead({ title: "Mobile app", organisation: "City Gym", source: "Google", value: "150000", stage: "contacted" });
  await lead({ title: "Social media management", organisation: "Green Café", source: "Walk-in", value: "96000", stage: "won" });
  await api("POST", c(`/crm/leads/${l1}/activities`), { kind: "call", summary: "Call to agree the pages and the budget", due_date: day(0) });
  await api("POST", c(`/crm/leads/${l1}/activities`), { kind: "meeting", summary: "Visited the clinic, saw their old site" });
  await api("POST", c("/service/contracts"), { contact_id: customers.kumar, title: "Computer AMC (10 PCs)", start_date: day(-340), end_date: day(20), billing: "quarterly", amount: "9000", visits_included: 4, covers: "10 computers, 2 printers" });
  await api("POST", c("/service/contracts"), { contact_id: customers.cafe, title: "Website maintenance", start_date: day(-10), end_date: day(355), billing: "monthly", amount: "2000" });
  const t1 = (await api("POST", c("/service/tickets"), { contact_id: customers.cafe, subject: "Billing printer not working", priority: "high", asset: "TVS RP3160" })).id;
  await api("POST", c(`/service/tickets/${t1}/notes`), { note: "Replaced the roller and tested", minutes: 90 });
  await api("POST", c(`/service/tickets/${t1}/notes`), { note: "Printer is working again", public: true });
  await api("POST", c("/service/tickets"), { contact_id: customers.kumar, subject: "Laptop running slow", priority: "normal" });
  const rfq = await api("POST", c("/purchasing/rfqs"), { title: "Office laptops for March", respond_by: day(7), notes: "Delivery to the Bengaluru office", supplier_ids: [suppliers.alpha, suppliers.beta],
    lines: [{ item_id: items["HW-LAP-01"], description: "Laptop i5 16GB", quantity: "5", unit: "nos" }, { description: "Laptop bag", quantity: "5", unit: "nos" }] });
  await api("POST", c(`/purchasing/rfqs/${rfq.id}/send`));
  const rx = await api("GET", c(`/purchasing/rfqs/${rfq.id}`));
  await api("POST", c(`/purchasing/rfqs/${rfq.id}/quotes/${suppliers.alpha}`), { prices: [{ line_id: rx.lines[0].id, unit_price: "54500" }, { line_id: rx.lines[1].id, unit_price: "950" }], delivery_days: 7 });
  await api("POST", c(`/purchasing/rfqs/${rfq.id}/quotes/${suppliers.beta}`), { prices: [{ line_id: rx.lines[0].id, unit_price: "56000" }, { line_id: rx.lines[1].id, unit_price: "900" }], delivery_days: 5 });
  const po = await doc({ doc_type: "purchase_order", contact_id: suppliers.alpha, issue_date: day(-8), lines: [line("HW-LAP-01", "3", "54000"), line("HW-MOU-01", "10", "550")] });
  const poLines = (await api("GET", c(`/purchasing/match/${po}`))).rows;
  await api("POST", c("/purchasing/grns"), { po_id: po, supplier_ref: "DC-881", lines: [{ line_no: poLines[0].line_no, received: "3", rejected: "1", reject_reason: "Screen scratched" }, { line_no: poLines[1].line_no, received: "10" }] });
  const pb = await api("POST", c(`/documents/${po}/convert`), { to: "bill" });
  await api("POST", c(`/documents/${pb.id}/issue`));
  await api("PUT", c("/approval-rules"), { rules: [{ doc_type: "purchase_order", min_amount: "50000", approver_role: "accountant", step: 1 }, { doc_type: "purchase_order", min_amount: "200000", approver_role: "admin", step: 2 }] });
  await doc({ doc_type: "purchase_order", contact_id: suppliers.beta, issue_date: day(0), lines: [{ description: "Studio lights and stands", quantity: "1", unit_price: "250000", account_id: acc.PURCHASES }] }, false);
  await api("POST", c("/settings/exchange-rates"), { currency: "USD", rate_date: day(-2), rate: "84.25" });
  await api("POST", c("/api-keys"), { name: "Website orders", access: "read" });
  const portal = { customer: (await api("POST", c(`/collection/portal/${customers.kumar}`), {})).token, supplier: (await api("POST", c(`/collection/portal/${suppliers.alpha}`), {})).token };
  return { id, customers, items: { laptop: items["HW-LAP-01"] }, invoice, bill, chequeOut, portal };
}

function html() {
  const logo = `data:image/png;base64,${readFileSync(join(ROOT, "public", "brand", "icon-192.png")).toString("base64")}`;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const block = (b: Block) => {
    switch (b.t) {
      case "p": return `<p>${esc(b.text)}</p>`;
      case "steps": return `<ol>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>`;
      case "list": return `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
      case "tip": return `<div class="tip"><b>Tip.</b> ${esc(b.text)}</div>`;
      case "img": { const src = shots.get(b.shot); if (!src) throw new Error(`No screenshot ${b.shot}`); return `<figure class="${b.phone ? "phone" : ""}"><img src="${src}"><figcaption>${esc(b.caption)}</figcaption></figure>`; }
      case "h3": return `<h3>${esc(b.text)}</h3>`;
    }
  };
  const toc = CHAPTERS.map((ch, i) => `<li><span>${i + 1}.</span> ${esc(ch.title)}</li>`).join("");
  const body = CHAPTERS.map((ch, i) => `<section><h2><span>${i + 1}</span>${esc(ch.title)}</h2>${ch.blocks.map(block).join("\n")}</section>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Foxlator User Manual</title><style>
    @page { size: A4; margin: 16mm 15mm 18mm; }
    body { font-family: "Segoe UI", Inter, Arial, sans-serif; color: #1e293b; font-size: 10.5pt; line-height: 1.5; }
    .cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
    .cover img { width: 64px; } .cover h1 { font-size: 34pt; margin: 18px 0 4px; color: #1d4ed8; } .cover p { font-size: 13pt; color: #475569; margin: 4px 0; }
    .toc { page-break-after: always; } .toc h2 { color: #1d4ed8; } .toc ol { list-style: none; padding: 0; columns: 2; } .toc li { margin: 5px 0; } .toc span { display: inline-block; width: 22px; color: #1d4ed8; font-weight: 600; }
    section { page-break-before: always; } section:first-of-type { page-break-before: auto; }
    h2 { font-size: 18pt; color: #0f172a; border-bottom: 2px solid #1d4ed8; padding-bottom: 6px; margin: 0 0 12px; }
    h2 span { display: inline-block; background: #1d4ed8; color: #fff; border-radius: 6px; padding: 0 9px; margin-right: 10px; font-size: 14pt; }
    h3 { font-size: 12.5pt; margin: 16px 0 6px; color: #1d4ed8; }
    p { margin: 6px 0; } ol, ul { margin: 6px 0 6px 20px; padding: 0; } li { margin: 3px 0; }
    figure { margin: 10px 0 14px; page-break-inside: avoid; } figure img { width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; }
    figure.phone img { width: 46%; } figcaption { font-size: 9pt; color: #64748b; margin-top: 4px; }
    .tip { background: #eff6ff; border-left: 4px solid #1d4ed8; padding: 8px 10px; margin: 10px 0; border-radius: 4px; page-break-inside: avoid; }
  </style></head><body>
    <div class="cover"><img src="${logo}"><h1>Foxlator</h1><p><b>User manual</b></p><p>Accounting, billing, GST, stock, CRM, service desk and purchasing — step by step, with screenshots.</p>
      <p style="margin-top:40px;font-size:10pt">Version ${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version} · ${new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</p>
      <p style="font-size:10pt">A product of Niyazio · Support: info@niyazio.com</p></div>
    <div class="toc"><h2>Contents</h2><ol>${toc}</ol>
      <p style="margin-top:20px">The screenshots show a demo company, <b>MNCG Digital & Creative Solutions</b>. Your screens show your own company and only the menus your role and your business type use (Settings → Features).</p></div>
    ${body}
  </body></html>`;
}

async function pdf() {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage();
  await page.setContent(html(), { waitUntil: "load" });
  mkdirSync(join(ROOT, "public", "manual"), { recursive: true });
  const out = await page.pdf({ format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>",
    footerTemplate: `<div style="font-size:8px;color:#64748b;width:100%;padding:0 15mm;display:flex;justify-content:space-between"><span>Foxlator user manual</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    margin: { top: "16mm", bottom: "18mm", left: "15mm", right: "15mm" } });
  writeFileSync(OUT, out);
  console.log("manual", OUT, Math.round(out.length / 1024), "KB");
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
