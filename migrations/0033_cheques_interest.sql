-- Cheque register: cheques received from customers and issued to suppliers, including post-dated ones (PDC).
-- A cheque posts nothing until it clears; clearing records the payment, a bounce reverses it.
CREATE TABLE cheques (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  contact_id TEXT NOT NULL,
  cheque_no TEXT NOT NULL,
  bank_name TEXT,
  cheque_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  account_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','deposited','cleared','bounced','cancelled')),
  status_date TEXT,
  payment_id TEXT,
  allocations TEXT,
  payee_name TEXT,
  notes TEXT,
  bounce_reason TEXT,
  printed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id)
);
CREATE INDEX idx_cheques_company ON cheques(company_id, status, cheque_date);

-- Interest on overdue invoices: yearly rate (basis points), days of grace after the due date, and how far interest was billed.
ALTER TABLE companies ADD COLUMN overdue_interest_bp INTEGER NOT NULL DEFAULT 1800;
ALTER TABLE companies ADD COLUMN overdue_interest_grace_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN cheque_layout TEXT;
ALTER TABLE documents ADD COLUMN interest_to TEXT;
