-- Requests for quotation: one request to several suppliers; they quote in their portal (or the buyer types the quote in);
-- the best quote becomes a purchase order.
CREATE TABLE rfqs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  title TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  respond_by TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','awarded','cancelled')),
  notes TEXT,
  awarded_contact_id TEXT,
  po_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, number),
  UNIQUE (company_id, id)
);
CREATE TABLE rfq_lines (
  id TEXT PRIMARY KEY,
  rfq_id TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  item_id TEXT,
  description TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit TEXT
);
CREATE TABLE rfq_suppliers (
  rfq_id TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','quoted','declined')),
  delivery_days INTEGER,
  valid_until TEXT,
  notes TEXT,
  quoted_at TEXT,
  entered_by TEXT,
  PRIMARY KEY (rfq_id, contact_id)
);
CREATE TABLE rfq_quotes (
  rfq_id TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  line_id TEXT NOT NULL REFERENCES rfq_lines(id) ON DELETE CASCADE,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (rfq_id, contact_id, line_id)
);

-- Goods receipt notes: what arrived against a purchase order, with the quantity accepted and rejected after inspection.
-- A GRN is a record for checking (3-way match); stock and the ledger still move with the supplier's bill.
CREATE TABLE grns (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  po_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  receipt_date TEXT NOT NULL,
  supplier_ref TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, number),
  UNIQUE (company_id, id)
);
CREATE INDEX idx_grns_po ON grns(company_id, po_id);
CREATE TABLE grn_lines (
  id TEXT PRIMARY KEY,
  grn_id TEXT NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
  po_line_no INTEGER NOT NULL,
  item_id TEXT,
  description TEXT NOT NULL,
  received_milli INTEGER NOT NULL CHECK (received_milli >= 0),
  accepted_milli INTEGER NOT NULL CHECK (accepted_milli >= 0),
  rejected_milli INTEGER NOT NULL DEFAULT 0 CHECK (rejected_milli >= 0),
  reject_reason TEXT
);
