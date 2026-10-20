-- Business modules: documents, payments, inventory, expenses, banking, fixed assets, budgets.
PRAGMA foreign_keys = ON;

-- ───────────────────────── Products & inventory ─────────────────────────
CREATE TABLE units (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (company_id, code)
);

CREATE TABLE warehouses (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  branch_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id)
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('goods','service')),
  name TEXT NOT NULL,
  sku TEXT,
  unit TEXT NOT NULL DEFAULT 'nos',
  hsn_sac TEXT,
  description TEXT,
  sale_price INTEGER NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
  purchase_price INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  tax_code_id TEXT,
  income_account_id TEXT,
  expense_account_id TEXT,
  track_inventory INTEGER NOT NULL DEFAULT 0,
  reorder_level_milli INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (track_inventory = 0 OR kind = 'goods'),
  UNIQUE (company_id, sku),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, tax_code_id) REFERENCES tax_codes(company_id, id),
  FOREIGN KEY (company_id, income_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, expense_account_id) REFERENCES accounts(company_id, id)
);

-- Perpetual inventory ledger. Costing method: moving weighted average per item (company-wide).
CREATE TABLE stock_moves (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  move_date TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli <> 0),   -- +in / -out
  value INTEGER NOT NULL,                              -- signed, base currency minor units
  kind TEXT NOT NULL CHECK (kind IN ('purchase','sale','adjustment','transfer','opening','return_in','return_out')),
  source_type TEXT,
  source_id TEXT,
  journal_entry_id TEXT,
  memo TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id)
);
CREATE INDEX idx_stock_item ON stock_moves(company_id, item_id, warehouse_id);

-- Stock can never go negative in a warehouse (checked inside the same transaction as the movement).
CREATE TRIGGER trg_stock_no_negative AFTER INSERT ON stock_moves
WHEN NEW.qty_milli < 0
BEGIN
  SELECT RAISE(ABORT, 'INSUFFICIENT_STOCK: not enough stock in the warehouse')
  WHERE (SELECT COALESCE(SUM(qty_milli),0) FROM stock_moves
         WHERE company_id = NEW.company_id AND item_id = NEW.item_id AND warehouse_id = NEW.warehouse_id) < 0;
END;

CREATE TRIGGER trg_stock_immutable_u BEFORE UPDATE ON stock_moves
BEGIN SELECT RAISE(ABORT, 'STOCK_IMMUTABLE: stock movements are append-only'); END;
CREATE TRIGGER trg_stock_immutable_d BEFORE DELETE ON stock_moves
BEGIN SELECT RAISE(ABORT, 'STOCK_IMMUTABLE: stock movements are append-only'); END;

-- ───────────────────────── Sales & purchase documents ─────────────────────────
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('quote','sales_order','invoice','credit_note','purchase_order','bill','debit_note')),
  number TEXT,
  contact_id TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','posted','accepted','declined','converted','closed','void')),
  currency TEXT NOT NULL,
  fx_rate_scaled INTEGER NOT NULL DEFAULT 1000000000 CHECK (fx_rate_scaled > 0),
  place_of_supply TEXT,
  tax_mode TEXT NOT NULL DEFAULT 'none' CHECK (tax_mode IN ('intra','inter','simple','none')),
  reference TEXT,             -- supplier invoice no. for bills, customer PO for invoices
  subtotal INTEGER NOT NULL DEFAULT 0,
  discount_total INTEGER NOT NULL DEFAULT 0,
  tax_total INTEGER NOT NULL DEFAULT 0,
  round_off INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  total_base INTEGER NOT NULL DEFAULT 0,
  amount_settled INTEGER NOT NULL DEFAULT 0 CHECK (amount_settled >= 0),
  notes TEXT,
  terms TEXT,
  related_doc_id TEXT,
  journal_entry_id TEXT,
  branch_id TEXT,
  warehouse_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  posted_by TEXT REFERENCES users(id),
  posted_at TEXT,
  CHECK (amount_settled <= total),
  UNIQUE (company_id, doc_type, number),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, related_doc_id) REFERENCES documents(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses(company_id, id)
);
CREATE INDEX idx_docs_company ON documents(company_id, doc_type, status, issue_date);
CREATE INDEX idx_docs_contact ON documents(company_id, contact_id);

-- A posted document's financial fields are frozen; only settlement and status (posted→void via reversal) may change.
CREATE TRIGGER trg_doc_posted_immutable BEFORE UPDATE ON documents
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: posted documents cannot be edited; issue a credit/debit note or void')
  WHERE NEW.total IS NOT OLD.total OR NEW.subtotal IS NOT OLD.subtotal OR NEW.tax_total IS NOT OLD.tax_total
     OR NEW.contact_id IS NOT OLD.contact_id OR NEW.issue_date IS NOT OLD.issue_date
     OR NEW.currency IS NOT OLD.currency OR NEW.fx_rate_scaled IS NOT OLD.fx_rate_scaled
     OR NEW.number IS NOT OLD.number OR NEW.journal_entry_id IS NOT OLD.journal_entry_id
     OR NEW.total_base IS NOT OLD.total_base OR NEW.doc_type IS NOT OLD.doc_type
     OR (NEW.status NOT IN ('posted','void'));
  SELECT RAISE(ABORT, 'SETTLED: a document with payments applied cannot be voided')
  WHERE NEW.status = 'void' AND OLD.amount_settled > 0;
END;

CREATE TRIGGER trg_doc_delete_guard BEFORE DELETE ON documents
WHEN OLD.status NOT IN ('draft')
BEGIN SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: only draft documents can be deleted'); END;

CREATE TABLE document_lines (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  item_id TEXT,
  description TEXT NOT NULL,
  hsn_sac TEXT,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),     -- document currency minor units
  discount_bp INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
  account_id TEXT,
  tax_code_id TEXT,
  taxable INTEGER NOT NULL DEFAULT 0,
  cgst INTEGER NOT NULL DEFAULT 0,
  sgst INTEGER NOT NULL DEFAULT 0,
  igst INTEGER NOT NULL DEFAULT 0,
  other_tax INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL DEFAULT 0,
  department_id TEXT,
  project_id TEXT,
  cost_centre_id TEXT,
  UNIQUE (document_id, line_no),
  FOREIGN KEY (company_id, document_id) REFERENCES documents(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, tax_code_id) REFERENCES tax_codes(company_id, id),
  FOREIGN KEY (company_id, department_id) REFERENCES departments(company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id),
  FOREIGN KEY (company_id, cost_centre_id) REFERENCES cost_centres(company_id, id)
);
CREATE INDEX idx_doclines_doc ON document_lines(document_id);

CREATE TRIGGER trg_docline_guard_i BEFORE INSERT ON document_lines
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: lines of a non-draft document cannot change')
  WHERE (SELECT status FROM documents WHERE id = NEW.document_id) <> 'draft';
END;
CREATE TRIGGER trg_docline_guard_u BEFORE UPDATE ON document_lines
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: lines of a non-draft document cannot change')
  WHERE (SELECT status FROM documents WHERE id = OLD.document_id) <> 'draft';
END;
CREATE TRIGGER trg_docline_guard_d BEFORE DELETE ON document_lines
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: lines of a non-draft document cannot change')
  WHERE (SELECT status FROM documents WHERE id = OLD.document_id) NOT IN ('draft');
END;

-- ───────────────────────── Payments & settlement ─────────────────────────
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),   -- in = customer receipt, out = supplier payment
  number TEXT,
  contact_id TEXT NOT NULL,
  payment_date TEXT NOT NULL,
  account_id TEXT NOT NULL,          -- bank / cash account
  currency TEXT NOT NULL,
  fx_rate_scaled INTEGER NOT NULL DEFAULT 1000000000 CHECK (fx_rate_scaled > 0),
  amount INTEGER NOT NULL CHECK (amount > 0),
  amount_base INTEGER NOT NULL,
  method TEXT,
  reference TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  journal_entry_id TEXT,
  idempotency_key TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, direction, number),
  UNIQUE (company_id, idempotency_key),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id)
);
CREATE INDEX idx_payments_company ON payments(company_id, direction, payment_date);

-- Applies a payment, credit note or debit note against an invoice/bill.
CREATE TABLE allocations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('payment','credit_note','debit_note')),
  payment_id TEXT,
  note_id TEXT,
  document_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount <> 0),  -- in document currency; negative only when reversing
  reverses_id TEXT UNIQUE REFERENCES allocations(id),
  allocation_date TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((source_kind = 'payment') = (payment_id IS NOT NULL)),
  CHECK ((source_kind <> 'payment') = (note_id IS NOT NULL)),
  FOREIGN KEY (company_id, payment_id) REFERENCES payments(company_id, id),
  FOREIGN KEY (company_id, note_id) REFERENCES documents(company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES documents(company_id, id)
);
CREATE INDEX idx_alloc_doc ON allocations(document_id);
CREATE INDEX idx_alloc_payment ON allocations(payment_id);
CREATE INDEX idx_alloc_note ON allocations(note_id);

CREATE TRIGGER trg_alloc_validate BEFORE INSERT ON allocations
BEGIN
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: negative allocations must reverse an existing allocation')
  WHERE NEW.amount < 0 AND (NEW.reverses_id IS NULL OR
    (SELECT amount FROM allocations WHERE id = NEW.reverses_id) <> -NEW.amount);
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: target must be a posted invoice or bill')
  WHERE (SELECT doc_type FROM documents WHERE id = NEW.document_id) NOT IN ('invoice','bill')
     OR (SELECT status FROM documents WHERE id = NEW.document_id) <> 'posted';
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: payment direction does not match document')
  WHERE NEW.payment_id IS NOT NULL AND NOT (
    ((SELECT direction FROM payments WHERE id = NEW.payment_id) = 'in'  AND (SELECT doc_type FROM documents WHERE id = NEW.document_id) = 'invoice') OR
    ((SELECT direction FROM payments WHERE id = NEW.payment_id) = 'out' AND (SELECT doc_type FROM documents WHERE id = NEW.document_id) = 'bill'));
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: payment currency or contact does not match document')
  WHERE NEW.payment_id IS NOT NULL AND (
    (SELECT currency FROM payments WHERE id = NEW.payment_id) <> (SELECT currency FROM documents WHERE id = NEW.document_id) OR
    (SELECT contact_id FROM payments WHERE id = NEW.payment_id) <> (SELECT contact_id FROM documents WHERE id = NEW.document_id));
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: payment is void')
  WHERE NEW.payment_id IS NOT NULL AND NEW.amount > 0 AND (SELECT status FROM payments WHERE id = NEW.payment_id) <> 'posted';
  SELECT RAISE(ABORT, 'OVER_ALLOCATED: allocations exceed the payment amount')
  WHERE NEW.payment_id IS NOT NULL AND
    (SELECT COALESCE(SUM(amount),0) FROM allocations WHERE payment_id = NEW.payment_id) + NEW.amount
      > (SELECT amount FROM payments WHERE id = NEW.payment_id);
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: note does not match document')
  WHERE NEW.note_id IS NOT NULL AND NOT (
    (SELECT status FROM documents WHERE id = NEW.note_id) = 'posted' AND
    (SELECT contact_id FROM documents WHERE id = NEW.note_id) = (SELECT contact_id FROM documents WHERE id = NEW.document_id) AND
    (SELECT currency FROM documents WHERE id = NEW.note_id) = (SELECT currency FROM documents WHERE id = NEW.document_id) AND (
      ((SELECT doc_type FROM documents WHERE id = NEW.note_id) = 'credit_note' AND (SELECT doc_type FROM documents WHERE id = NEW.document_id) = 'invoice') OR
      ((SELECT doc_type FROM documents WHERE id = NEW.note_id) = 'debit_note'  AND (SELECT doc_type FROM documents WHERE id = NEW.document_id) = 'bill')));
END;

-- Keep documents.amount_settled in sync; CHECK(amount_settled <= total) rejects over-allocation atomically.
CREATE TRIGGER trg_alloc_settle AFTER INSERT ON allocations
BEGIN
  UPDATE documents SET amount_settled = amount_settled + NEW.amount WHERE id = NEW.document_id;
  UPDATE documents SET amount_settled = amount_settled + NEW.amount WHERE id = NEW.note_id;
END;
CREATE TRIGGER trg_alloc_immutable BEFORE UPDATE ON allocations
BEGIN SELECT RAISE(ABORT, 'ALLOCATION_IMMUTABLE'); END;
CREATE TRIGGER trg_alloc_no_delete BEFORE DELETE ON allocations
BEGIN SELECT RAISE(ABORT, 'ALLOCATION_IMMUTABLE'); END;

-- ───────────────────────── Expenses ─────────────────────────
CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT,
  expense_date TEXT NOT NULL,
  contact_id TEXT,
  category_account_id TEXT NOT NULL,
  paid_from_account_id TEXT NOT NULL,
  description TEXT NOT NULL,
  currency TEXT NOT NULL,
  fx_rate_scaled INTEGER NOT NULL DEFAULT 1000000000,
  amount INTEGER NOT NULL CHECK (amount > 0),         -- net of tax, expense currency
  tax_code_id TEXT,
  tax_mode TEXT NOT NULL DEFAULT 'none',
  tax_amount INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total INTEGER NOT NULL CHECK (total > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','posted')),
  department_id TEXT,
  project_id TEXT,
  cost_centre_id TEXT,
  submitted_by TEXT REFERENCES users(id),
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  rejection_reason TEXT,
  journal_entry_id TEXT,
  template_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, id),
  UNIQUE (company_id, number),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, category_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, paid_from_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, tax_code_id) REFERENCES tax_codes(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, department_id) REFERENCES departments(company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id),
  FOREIGN KEY (company_id, cost_centre_id) REFERENCES cost_centres(company_id, id)
);
CREATE INDEX idx_expenses_company ON expenses(company_id, status, expense_date);

CREATE TRIGGER trg_expense_posted_immutable BEFORE UPDATE ON expenses
WHEN OLD.status = 'posted'
BEGIN SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: posted expenses cannot be edited'); END;
CREATE TRIGGER trg_expense_delete_guard BEFORE DELETE ON expenses
WHEN OLD.status = 'posted'
BEGIN SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: posted expenses cannot be deleted'); END;

CREATE TABLE recurring_templates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('expense')),
  name TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
  next_run_date TEXT NOT NULL,
  end_date TEXT,
  payload TEXT NOT NULL,          -- JSON
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, id)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('expense','document','journal','payment','asset')),
  entity_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_attach_entity ON attachments(company_id, entity_type, entity_id);

-- ───────────────────────── Banking ─────────────────────────
CREATE TABLE bank_imports (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  filename TEXT,
  row_count INTEGER NOT NULL,
  imported_count INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id)
);

CREATE TABLE bank_reconciliations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  statement_date TEXT NOT NULL,
  statement_balance INTEGER NOT NULL,
  cleared_balance INTEGER NOT NULL,
  book_balance INTEGER NOT NULL,
  difference INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  completed_by TEXT NOT NULL REFERENCES users(id),
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id)
);

CREATE TABLE bank_statement_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  import_id TEXT,
  txn_date TEXT NOT NULL,
  description TEXT NOT NULL,
  reference TEXT,
  amount INTEGER NOT NULL CHECK (amount <> 0),   -- +deposit / -withdrawal, base currency of the bank account
  running_balance INTEGER,
  dedupe_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','ignored')),
  matched_line_id TEXT,
  reconciliation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, account_id, dedupe_hash),
  UNIQUE (matched_line_id),
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, import_id) REFERENCES bank_imports(company_id, id),
  FOREIGN KEY (company_id, reconciliation_id) REFERENCES bank_reconciliations(company_id, id)
);
CREATE INDEX idx_bsl_account ON bank_statement_lines(company_id, account_id, status, txn_date);

CREATE TRIGGER trg_bsl_reconciled_guard BEFORE UPDATE ON bank_statement_lines
WHEN OLD.reconciliation_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'RECONCILED: reconciled statement lines cannot be changed'); END;

-- ───────────────────────── Fixed assets ─────────────────────────
CREATE TABLE fixed_assets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  acquisition_date TEXT NOT NULL,
  depreciation_start_date TEXT NOT NULL,
  cost INTEGER NOT NULL CHECK (cost > 0),
  salvage_value INTEGER NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
  method TEXT NOT NULL CHECK (method IN ('slm','wdv')),
  useful_life_months INTEGER CHECK (useful_life_months > 0),
  wdv_rate_bp INTEGER CHECK (wdv_rate_bp > 0 AND wdv_rate_bp <= 10000),
  asset_account_id TEXT NOT NULL,
  accum_dep_account_id TEXT NOT NULL,
  dep_expense_account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disposed')),
  disposal_date TEXT,
  disposal_proceeds INTEGER,
  acquisition_journal_id TEXT,
  disposal_journal_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (salvage_value < cost),
  CHECK ((method = 'slm' AND useful_life_months IS NOT NULL) OR (method = 'wdv' AND wdv_rate_bp IS NOT NULL)),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, asset_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, accum_dep_account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, dep_expense_account_id) REFERENCES accounts(company_id, id)
);

CREATE TABLE depreciation_entries (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  period_month TEXT NOT NULL,          -- 'YYYY-MM'
  amount INTEGER NOT NULL CHECK (amount > 0),
  journal_entry_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (asset_id, period_month),
  FOREIGN KEY (company_id, asset_id) REFERENCES fixed_assets(company_id, id),
  FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries(company_id, id)
);

-- ───────────────────────── Budgets ─────────────────────────
CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  fiscal_year_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, name),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, fiscal_year_id) REFERENCES fiscal_years(company_id, id)
);

CREATE TABLE budget_lines (
  budget_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  period_month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (budget_id, account_id, period_month),
  FOREIGN KEY (company_id, budget_id) REFERENCES budgets(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id)
);
