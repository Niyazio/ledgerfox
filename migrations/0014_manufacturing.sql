-- Manufacturing: bills of materials and production entries. Additive only.
-- Stock movements of a production entry use kind 'adjustment' with source_type 'production' / 'production_void'.
CREATE TABLE boms (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,                       -- finished product
  name TEXT NOT NULL,
  output_qty_milli INTEGER NOT NULL CHECK (output_qty_milli > 0),
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id)
);
CREATE INDEX idx_boms_item ON boms(company_id, item_id);

CREATE TABLE bom_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  bom_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  item_id TEXT NOT NULL,                       -- component
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  FOREIGN KEY (company_id, bom_id) REFERENCES boms(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id)
);
CREATE INDEX idx_bom_lines_bom ON bom_lines(bom_id, line_no);

CREATE TABLE production_orders (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  bom_id TEXT,
  item_id TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  production_date TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  material_cost INTEGER NOT NULL,
  extra_cost INTEGER NOT NULL DEFAULT 0 CHECK (extra_cost >= 0),
  extra_account_id TEXT,
  total_cost INTEGER NOT NULL,
  journal_entry_id TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  void_journal_id TEXT,
  batch_no TEXT,
  expiry_date TEXT,
  memo TEXT,
  branch_id TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  voided_by TEXT REFERENCES users(id),
  voided_at TEXT,
  UNIQUE (company_id, number),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses(company_id, id)
);
CREATE INDEX idx_production_company ON production_orders(company_id, production_date);

CREATE TABLE production_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  production_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  value INTEGER NOT NULL,
  FOREIGN KEY (company_id, production_id) REFERENCES production_orders(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, item_id) REFERENCES items(company_id, id)
);
CREATE INDEX idx_production_lines ON production_lines(production_id);
