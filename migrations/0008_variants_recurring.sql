-- Proforma invoices (a quote variant) and delivery challans (a sales-order variant), without rebuilding `documents`
-- (a rebuild would cascade-delete document lines). Recurring invoice schedules. Additive only.
ALTER TABLE documents ADD COLUMN variant TEXT CHECK (variant IS NULL OR variant IN ('proforma','delivery_challan'));
CREATE INDEX idx_documents_variant ON documents(company_id, doc_type, variant);

CREATE TABLE recurring_invoices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_document_id TEXT NOT NULL,           -- an issued invoice whose lines are copied
  name TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
  next_date TEXT NOT NULL,
  anchor_day INTEGER NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),   -- day of month to keep (31 → last day of shorter months)
  end_date TEXT,
  auto_issue INTEGER NOT NULL DEFAULT 0 CHECK (auto_issue IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  last_document_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (company_id, template_document_id) REFERENCES documents(company_id, id)
);
CREATE INDEX idx_recurring_invoices_due ON recurring_invoices(company_id, is_active, next_date);
