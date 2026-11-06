-- Serial numbers, project time billing, advances on quotations / proformas. Additive only.

-- Serial numbers: products tracked one by one (phones, appliances, machines). Bills bring serials in, invoices take
-- them out, returns bring them back; each serial is in stock or out.
ALTER TABLE items ADD COLUMN track_serials INTEGER NOT NULL DEFAULT 0 CHECK (track_serials IN (0,1));
ALTER TABLE document_lines ADD COLUMN serials TEXT;          -- JSON list of serial numbers on the line
CREATE TABLE item_serials (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  serial TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_stock','out')),
  in_doc_id TEXT,                                            -- the bill (or credit note) that brought it in
  out_doc_id TEXT,                                           -- the invoice (or debit note) that took it out
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, item_id, serial)
);
CREATE INDEX idx_item_serials_serial ON item_serials(company_id, serial);

-- Projects: who they are for and the hourly rate; time worked, billed on an invoice.
ALTER TABLE projects ADD COLUMN contact_id TEXT;
ALTER TABLE projects ADD COLUMN hourly_rate INTEGER;
CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  user_id TEXT,
  work_date TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  description TEXT NOT NULL,
  billable INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0,1)),
  rate INTEGER,                                              -- per hour, base currency; the project's rate when empty
  invoice_id TEXT,                                           -- set when billed
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_time_entries_project ON time_entries(company_id, project_id, work_date);

-- Advances (retainers) taken against a quotation, proforma or sales order; applied to its invoice when issued.
CREATE TABLE advance_links (
  payment_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_advance_links_doc ON advance_links(document_id);
