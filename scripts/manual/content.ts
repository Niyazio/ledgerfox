/** The chapters of the user manual. `img` names a screenshot taken by build.ts. */
export type Block =
  | { t: "p"; text: string }
  | { t: "h3"; text: string }
  | { t: "steps"; items: string[] }
  | { t: "list"; items: string[] }
  | { t: "tip"; text: string }
  | { t: "img"; shot: string; caption: string; phone?: boolean };

export const CHAPTERS: { title: string; blocks: Block[] }[] = [
  {
    title: "Getting started",
    blocks: [
      { t: "p", text: "LedgerFox is accounting and billing software that works in the browser, as a desktop app (Windows, macOS, Linux) and as an Android app. Your data is kept safely online, so every device sees the same books, and several people can work at the same time." },
      { t: "h3", text: "Create your account and company" },
      { t: "steps", items: [
        "Open the LedgerFox website and choose **Get started** (or **Sign in** if you already have an account). New accounts get a 30-day free trial.",
        "Enter your name, email and a password. Keep the recovery codes shown after sign-up in a safe place: they let you back in if you forget your password.",
        "Create your organisation and your first company: name, country, currency, the month your financial year starts, your state, and your type of business.",
        "LedgerFox sets up the chart of accounts, tax codes (GST for India, VAT for other countries) and number series for you.",
      ] },
      { t: "img", shot: "login", caption: "Sign in. Your browser remembers you on this device; use Sign out on shared computers." },
      { t: "h3", text: "The main screen" },
      { t: "p", text: "The menu on the left is grouped as Sales & billing, Purchases, Inventory, Accounting, People, Reports & control and Administration. At the top are the company switcher, the branch, the financial year, your role, the language, the theme, and Sign out. The **Ask** button at the bottom right answers questions about your books and about using LedgerFox." },
      { t: "img", shot: "dashboard", caption: "The dashboard: sales, purchases, what customers owe you, what you owe suppliers, cash and bank balances, and what needs attention today." },
      { t: "tip", text: "Press the keyboard icon at the top to see shortcuts: F8 new invoice, F9 supplier bill, F6 receipt, F5 payment, F7 journal, Alt+R reports. Install LedgerFox as an app with the Install app button for a full-screen window." },
    ],
  },
  {
    title: "Setting up your company",
    blocks: [
      { t: "p", text: "Open **Settings** to fill in the details printed on your invoices and to decide how LedgerFox works for you." },
      { t: "list", items: [
        "**Company**: legal name, address, GSTIN / tax number, phone, email, logo, signature, UPI ID and payment QR, invoice terms, print layout.",
        "**Features**: switch off what your business does not use (barcode scanning, POS, stock, manufacturing, payroll…). Menus disappear; nothing is deleted.",
        "**Users & permissions**: invite your team and give each a role (admin, billing, purchase, accountant, inventory, auditor).",
        "**Tax**, **Numbering**, **Currencies**, **Fiscal periods** (lock a period after closing), **Data export**.",
      ] },
      { t: "img", shot: "settings", caption: "Settings → Company: the details that appear on every document." },
      { t: "img", shot: "features", caption: "Settings → Features: a school, an agency or a clinic hides what it does not need." },
      { t: "h3", text: "Your team" },
      { t: "steps", items: [
        "Settings → Users & permissions → **Invite**: enter the person's email and choose a role.",
        "They receive a link, set their password and see only what their role allows. You can limit a person to certain branches.",
        "The owner can change what each role may do, require two-factor sign-in for everyone, and see every change in the **Audit log**.",
      ] },
      { t: "img", shot: "users", caption: "Users & permissions: roles, branches and two-factor sign-in." },
    ],
  },
  {
    title: "Customers and suppliers",
    blocks: [
      { t: "p", text: "Add customers under **Customers** and suppliers under **Suppliers** (a party who is both can be marked so). Enter the GSTIN and LedgerFox fills in the state, so CGST + SGST or IGST is worked out correctly on every invoice." },
      { t: "img", shot: "customers", caption: "Customers: what each one owes, with search and export to Excel." },
      { t: "p", text: "Click a name to open the customer's page: everything they bought, what they paid in cash or by bank, what is outstanding and overdue, their statement, and their **portal link** (see chapter 6)." },
      { t: "img", shot: "customer", caption: "A customer's page: documents, products, payments, balance and profit." },
      { t: "tip", text: "Set a credit limit and credit days on a customer. LedgerFox warns before an invoice takes them over the limit." },
    ],
  },
  {
    title: "Products and services",
    blocks: [
      { t: "p", text: "**Products & stock** holds everything you sell or buy: goods (with stock) and services. Each item has a code, HSN / SAC, tax rate, unit, selling and purchase price, and a description that prints on invoices." },
      { t: "img", shot: "inventory", caption: "Products & stock: quantity on hand and stock value per item." },
      { t: "img", shot: "product", caption: "A product's page: stock by warehouse, every sale and purchase, margin, and its best customers." },
      { t: "h3", text: "Import a whole list at once" },
      { t: "steps", items: [
        "Administration → **Import from Excel** → choose **Products, services & opening stock**.",
        "Download the Excel template, fill one row per product (only the name is required), or use your own sheet: columns are matched by name.",
        "A PDF price list or rate card also works if it has a header row. Rates such as “₹8,000/month” give the price and the unit.",
        "Click **Check file**, fix any rows listed, then **Import**. Tick **Update products that already exist** to change prices, tax, HSN or descriptions of existing items.",
      ] },
      { t: "img", shot: "import", caption: "Import from Excel, CSV or PDF: products, customers and suppliers, and the chart of accounts." },
    ],
  },
  {
    title: "Selling: quotations, invoices and POS",
    blocks: [
      { t: "p", text: "The usual path is **Quotation → Sales order → Invoice → Receipt**, but you can start at any step. Each document can be converted to the next with one click, so nothing is typed twice." },
      { t: "h3", text: "Make an invoice" },
      { t: "steps", items: [
        "Sales & billing → **Invoices** → **New** (or press F8).",
        "Choose the customer. Add lines by product name, code or barcode scan; quantity, price, discount and tax fill in.",
        "Check the totals, then **Issue**. The invoice gets its number and is posted to the books.",
        "Print, download the PDF, or share it on WhatsApp or by email. Each invoice carries a QR code anyone can scan to check it is genuine.",
      ] },
      { t: "img", shot: "invoice-new", caption: "A new invoice: lines, taxes and totals as you type." },
      { t: "img", shot: "invoice", caption: "An issued invoice: status, payments received, and actions (print, share, credit note, e-invoice)." },
      { t: "img", shot: "invoice-print", caption: "Print preview: choose the layout (A4 modern or classic, A5, thermal 80 mm or 58 mm) and share the PDF." },
      { t: "list", items: [
        "**Quotations** can be accepted by the customer from their portal, then converted.",
        "**Credit notes** (Sales returns) correct or cancel an issued invoice; issued invoices are never edited, as the law requires.",
        "**Recurring invoices** are made automatically every month, quarter or year (rent, fees, retainers).",
        "**POS / counter billing** is a fast screen for shops: scan, take cash, card or UPI, and print a thermal receipt.",
        "**GST e-invoice and e-way bill**: download the file to upload on the government portal and save the IRN / e-way bill number.",
      ] },
      { t: "img", shot: "quotes", caption: "Quotations, with their status (open, accepted, declined, converted)." },
      { t: "img", shot: "recurring", caption: "Recurring invoices: the schedule and the next date." },
      { t: "img", shot: "pos", caption: "POS / counter billing." },
    ],
  },
  {
    title: "Getting paid",
    blocks: [
      { t: "p", text: "Record money received under **Receipts** (F6). Choose the customer, the bank or cash account and the amount; tick the invoices it pays. An amount not applied stays as an advance for later." },
      { t: "img", shot: "receipt-new", caption: "A receipt applied to the customer's open invoices." },
      { t: "h3", text: "The customer portal" },
      { t: "p", text: "Every customer can have a private link (customer page → **Customer portal**). There they see their invoices and payments, download PDFs, accept quotations, pay online (once online payments are set up), and raise support requests. Send the link once by WhatsApp or email." },
      { t: "img", shot: "portal-customer", caption: "The customer's portal on a phone.", phone: true },
      { t: "tip", text: "Automatic payment reminders (before the due date, on it, and after) are switched on in Settings → Payments & reminders, where you also set up online payments, so you do not have to chase every customer." },
    ],
  },
  {
    title: "Buying and paying suppliers",
    blocks: [
      { t: "p", text: "Record what you buy as **Supplier bills** (F9): the supplier's invoice number, the items or expense accounts, and the taxes. Goods bills add to stock. Pay them under **Supplier payments** (F5)." },
      { t: "img", shot: "suppliers", caption: "Suppliers and what you owe each one." },
      { t: "img", shot: "bill", caption: "A supplier bill with its input tax, ready to pay." },
      { t: "h3", text: "The supplier portal" },
      { t: "p", text: "Suppliers get a private link too (supplier page → **Supplier portal**). They see your purchase orders and accept or decline them, quote on your requests for quotation, see their bills in your books, your payments to them, and what you still owe." },
      { t: "img", shot: "portal-supplier", caption: "The supplier's portal on a phone.", phone: true },
    ],
  },
  {
    title: "Purchasing: quotations from suppliers, goods receipts and matching",
    blocks: [
      { t: "p", text: "Purchases → **RFQ, receipts & matching** covers the full buying process: ask several suppliers for prices, compare, order, receive the goods, and check the bill." },
      { t: "h3", text: "Request for quotation (RFQ)" },
      { t: "steps", items: [
        "**New RFQ**: a title, what you need (items and quantities), the date to reply by, and the suppliers to ask.",
        "**Send to suppliers**: each supplier gets their portal link, where the request appears for them to quote. Send the link by WhatsApp or email.",
        "Quotes appear side by side as they arrive (type in a quote that came by email or phone with **Enter quote**). The lowest price per line and the lowest total are marked.",
        "**Award** the best quote: a purchase order is made at the quoted prices. Each supplier sees whether their quote was selected.",
      ] },
      { t: "img", shot: "rfq", caption: "Quote comparison: prices per unit, delivery days, totals; Award makes the purchase order." },
      { t: "h3", text: "Goods receipt (GRN) and quality check" },
      { t: "p", text: "When goods arrive, **Receive goods** against the purchase order: how many came, how many were rejected after checking, and why. Stock and the books move when you enter the supplier's bill (convert the purchase order to a bill)." },
      { t: "img", shot: "grn", caption: "Goods receipts, with what was rejected." },
      { t: "h3", text: "3-way match" },
      { t: "p", text: "For every purchase order LedgerFox compares the **order**, the **goods received** and the **bill**, line by line, and flags: short receipt, billed more than received, bill price above the order, goods rejected. Pay only for what was received and accepted, at the ordered price." },
      { t: "img", shot: "match", caption: "3-way match: the second laptop line was billed for 3 but only 2 were accepted." },
      { t: "h3", text: "Landed cost" },
      { t: "p", text: "Freight, customs duty, clearing and insurance are part of the cost of imported or transported goods. Choose the goods bill, enter the charges and the account they were booked to, and spread them by value or quantity: the stock value and margins are then right." },
      { t: "img", shot: "landed", caption: "Landed cost: charges spread over the items of a bill." },
    ],
  },
  {
    title: "Approvals",
    blocks: [
      { t: "p", text: "Administration → **Approvals** sets who must approve what before it is issued. For example: purchase orders from ₹50,000 need the accountant (step 1); from ₹2,00,000 also an admin (step 2)." },
      { t: "list", items: [
        "The person who made a document cannot approve it, and each step needs a different person.",
        "The Approvals page lists everything waiting, and for whom. Approvers click **Approve**.",
        "Until every step is approved, Issue is refused with a clear message. The owner can issue without approval.",
        "Approvals are recorded in the audit log with the time and the approver.",
      ] },
      { t: "img", shot: "approvals", caption: "Approvals: what is waiting, and the rules." },
    ],
  },
  {
    title: "Expenses, banking and cheques",
    blocks: [
      { t: "p", text: "Record day-to-day spending under **Expenses** (rent, internet, travel, fuel). **Banking** imports your bank statement (Excel or CSV), matches each line to the entries in LedgerFox, and reconciles the account. A **contra entry** records cash deposited, cash withdrawn, or a transfer between bank accounts." },
      { t: "img", shot: "expenses", caption: "Expenses." },
      { t: "img", shot: "banking", caption: "Banking: statement import, matching and reconciliation." },
      { t: "h3", text: "Cheques and post-dated cheques (PDC)" },
      { t: "steps", items: [
        "Accounting → **Cheques & interest** → **Cheque received** (or **Issue a cheque**). A future date makes it a post-dated cheque.",
        "Nothing is posted until the cheque clears. On the date, click **Deposit**, then **Cleared**: the receipt or payment is recorded and applied to the invoices you chose.",
        "If it bounces, click **Bounced**: the receipt is reversed and the invoice is unpaid again.",
      ] },
      { t: "img", shot: "cheques", caption: "The cheque register: to receive, to pay, and what is due today." },
      { t: "h3", text: "Print a cheque" },
      { t: "p", text: "For an issued cheque, **Print** fills the date boxes, the payee, the amount in words and figures, and the A/c Payee crossing on a standard cheque leaf. Use **Adjust positions** once for your bank's cheque book and save." },
      { t: "img", shot: "cheque-print", caption: "Cheque printing preview." },
      { t: "h3", text: "Interest on overdue invoices" },
      { t: "p", text: "The **Interest on overdue** tab works out simple interest on unpaid invoices after the due date (and any days of grace) at your rate, per customer, and makes a draft interest invoice in one click. The same days are never charged twice." },
      { t: "img", shot: "interest", caption: "Interest due by customer." },
    ],
  },
  {
    title: "Accounting",
    blocks: [
      { t: "p", text: "Invoices, bills, receipts, payments, expenses and stock post to the books by themselves. An accountant uses **Journals & ledgers** for everything else: adjustments, provisions, opening balances, depreciation." },
      { t: "img", shot: "journals", caption: "Journals: every entry, with its source document." },
      { t: "img", shot: "accounts", caption: "Chart of accounts: groups and ledgers with balances. Add your own, or import a list." },
      { t: "list", items: [
        "**Daybook** shows every entry of a day, who made it and who approved it.",
        "**Fiscal periods**: lock a month or year after closing so nothing changes behind the auditor.",
        "**Currency revaluation**: at month end, open invoices and bills in other currencies are valued at the latest rate; the unrealised gain or loss is posted and reversed the next day.",
        "**Fixed assets** with depreciation, **Payroll** with payslips and statutory files, **Budgets**, **Cost centres** and **Branches**.",
      ] },
      { t: "img", shot: "daybook", caption: "The daybook." },
      { t: "img", shot: "fx", caption: "Currency revaluation of an open US-dollar invoice." },
    ],
  },
  {
    title: "Reports, GST and audit",
    blocks: [
      { t: "p", text: "**All reports** (Alt+R) lists every report: profit & loss, balance sheet, cash flow, trial balance, general ledger, receivables and payables ageing, sales by customer, purchases by supplier, expenses, stock valuation, budgets. Click any figure to see the entries behind it. Every report can be printed or exported to Excel." },
      { t: "img", shot: "reports", caption: "All reports." },
      { t: "img", shot: "profit-loss", caption: "Profit & loss for the period." },
      { t: "img", shot: "balance-sheet", caption: "Balance sheet." },
      { t: "h3", text: "GST returns" },
      { t: "p", text: "**GST returns** prepares GSTR-1 and GSTR-3B from your invoices and bills, matches your purchases with GSTR-2B, and downloads the files to upload on the GST portal." },
      { t: "img", shot: "gst", caption: "GST returns." },
      { t: "h3", text: "Tax check: fix mistakes before filing" },
      { t: "p", text: "**Tax check** finds what would make a return wrong: a wrong GSTIN, a state that does not match the GSTIN, products without HSN / SAC or tax rate, drafts without tax. Most can be fixed right there with one click." },
      { t: "img", shot: "tax-check", caption: "Tax check with fix buttons." },
      { t: "h3", text: "Audit checks" },
      { t: "p", text: "**Audit checks** looks at what auditors look at first: cash payments over ₹10,000 and cash receipts of ₹2,00,000 or more to one party in a day, negative cash, duplicate supplier bills, late entries, manual journals to control accounts, missing invoice numbers, ledgers that do not agree with their details, and unlocked periods." },
      { t: "img", shot: "audit-checks", caption: "Audit checks for the year." },
    ],
  },
  {
    title: "Leads & CRM",
    blocks: [
      { t: "p", text: "**Leads & CRM** follows every enquiry from the first call to won or lost, so no follow-up is forgotten." },
      { t: "steps", items: [
        "**New lead**: what they want, who, phone, email, source (website, referral, Instagram…), and the expected value.",
        "Log each call, meeting, WhatsApp or note on the lead, and plan the next follow-up with a date.",
        "Move the lead along the pipeline: New → Contacted → Qualified → Proposal sent → Won or Lost (with the reason).",
        "**Make customer & quotation** creates the customer and a draft quotation in one click.",
      ] },
      { t: "img", shot: "crm", caption: "The pipeline: open value, won value and win rate." },
      { t: "img", shot: "lead", caption: "A lead: contact buttons, stage, activities and the next follow-up." },
      { t: "img", shot: "followups", caption: "Follow-ups due this week, with the overdue ones first." },
      { t: "tip", text: "The Sources & win rate tab shows which source brings the most business, and why leads are lost." },
    ],
  },
  {
    title: "Service desk and AMC contracts",
    blocks: [
      { t: "p", text: "**Service desk & AMC** is for businesses that support their customers: IT and computer services, repairs, website maintenance, equipment." },
      { t: "h3", text: "Tickets" },
      { t: "list", items: [
        "A ticket has the customer, the problem, the product or serial number, a priority and an assignee. The due date follows the priority: urgent the same day, high 1 day, normal 3, low 7.",
        "Add work notes with the minutes spent; tick **Show to customer** for replies the customer should see in their portal.",
        "A ticket is resolved with a note of what fixed it. **Bill this ticket** makes a draft invoice for the time and parts.",
        "Customers raise requests themselves from their portal link.",
      ] },
      { t: "img", shot: "tickets", caption: "Open tickets by priority and due date." },
      { t: "img", shot: "ticket", caption: "A ticket with its work notes and time." },
      { t: "h3", text: "AMC / service contracts" },
      { t: "p", text: "A contract has the customer, the period, what it covers, the visits included, and the billing (monthly, quarterly, yearly or once). **Bill next period** makes the invoice for the next unbilled period. Contracts expiring within 30 days are shown so you can **Renew** them; tickets opened during a contract are marked as covered." },
      { t: "img", shot: "contracts", caption: "AMC / service contracts, with the ones expiring soon." },
    ],
  },
  {
    title: "API keys and connecting other software",
    blocks: [
      { t: "p", text: "Administration → **API keys** connects your website, online shop or other software to LedgerFox. A key is read-only or read-write, works for one company only, is shown once, and can be revoked at any time." },
      { t: "img", shot: "api-keys", caption: "API keys and how to use them." },
      { t: "p", text: "To be told when something happens (an invoice issued, a payment received), add a webhook in Settings → Customise → Automations." },
    ],
  },
  {
    title: "Apps, safety and help",
    blocks: [
      { t: "list", items: [
        "**Apps**: LedgerFox runs in any modern browser, as a desktop app for Windows, macOS and Linux, and as an Android app. Install it from the Install app button or the Download page.",
        "**Languages**: menus in English, Hindi, Tamil, Malayalam, Kannada and Arabic; invoices can also print in Hindi or Tamil.",
        "**Your data**: kept online, the same on every device. Settings → Data export downloads everything at any time, so your data is always yours.",
        "**Security**: two-factor sign-in, roles and branch limits, period locks, and an audit log of every change.",
        "**Education mode**: approved teachers and institutes get practice companies for their students.",
      ] },
      { t: "h3", text: "Getting help" },
      { t: "p", text: "Click **Ask** at the bottom right of any screen for help about your books or the software. For anything else, write to **info@niyazio.com**." },
    ],
  },
];
