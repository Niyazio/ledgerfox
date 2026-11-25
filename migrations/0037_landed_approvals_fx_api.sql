-- Landed cost: freight, customs and other charges added to the stock value of the items on a purchase bill.
CREATE TABLE landed_costs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bill_id TEXT NOT NULL,
  cost_date TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('value','quantity')),
  total INTEGER NOT NULL CHECK (total > 0),
  credit_account_id TEXT NOT NULL,
  journal_entry_id TEXT,
  details TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_landed_costs_bill ON landed_costs(company_id, bill_id);

-- Approval rules: documents of a type at or above an amount need approval by a role, step by step.
CREATE TABLE approval_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  min_amount INTEGER NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  approver_role TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 1 CHECK (step BETWEEN 1 AND 5),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE document_approval_steps (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  note TEXT,
  PRIMARY KEY (document_id, rule_id)
);

-- Month-end revaluation of open foreign-currency invoices and bills (reversed the next day).
CREATE TABLE fx_revaluations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  as_of TEXT NOT NULL,
  total INTEGER NOT NULL,
  journal_entry_id TEXT,
  reversal_entry_id TEXT,
  details TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, as_of)
);

-- API keys for the public API (/api/v1): only a hash of the key is stored.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  access TEXT NOT NULL DEFAULT 'read' CHECK (access IN ('read','write')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  revoked_at TEXT
);
