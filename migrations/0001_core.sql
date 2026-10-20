-- LedgerFox core schema (Cloudflare D1 / SQLite)
-- Conventions:
--   * Money is stored as INTEGER minor units (e.g. paise). Never REAL.
--   * Quantities are INTEGER milli-units (qty * 1000).
--   * Exchange rates are INTEGER scaled by 1e9 (base currency units per 1 foreign unit).
--   * Dates are TEXT 'YYYY-MM-DD'; timestamps are TEXT ISO-8601 UTC.
--   * Every tenant-owned row carries company_id; composite foreign keys
--     (company_id, x_id) stop rows from referencing another company's data.

PRAGMA foreign_keys = ON;

-- ───────────────────────── Identity ─────────────────────────
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iters INTEGER NOT NULL,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- SHA-256 of the session token (token itself is never stored)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_recovery_user ON recovery_codes(user_id);

CREATE TABLE password_resets (
  id TEXT PRIMARY KEY,               -- SHA-256 of token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- ───────────────────────── Tenancy ─────────────────────────
CREATE TABLE organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','accountant','auditor','viewer')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','accountant','auditor','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_invitations_org ON invitations(org_id);

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  legal_name TEXT,
  country TEXT NOT NULL,                       -- ISO 3166-1 alpha-2
  base_currency TEXT NOT NULL,                 -- ISO 4217
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 4 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  tax_id TEXT,                                 -- e.g. GSTIN
  state_code TEXT,                             -- e.g. Indian GST state code '29'
  address TEXT,
  city TEXT,
  postal_code TEXT,
  phone TEXT,
  email TEXT,
  date_format TEXT NOT NULL DEFAULT 'DD-MM-YYYY',
  number_locale TEXT NOT NULL DEFAULT 'en-IN',
  round_off_invoices INTEGER NOT NULL DEFAULT 0,
  invoice_terms TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_companies_org ON companies(org_id);

CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  state_code TEXT,
  address TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

CREATE TABLE cost_centres (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

CREATE TABLE number_sequences (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  prefix TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  padding INTEGER NOT NULL DEFAULT 5,
  PRIMARY KEY (company_id, key)
);

-- ───────────────────────── Currency ─────────────────────────
CREATE TABLE exchange_rates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  rate_date TEXT NOT NULL,
  rate_scaled INTEGER NOT NULL CHECK (rate_scaled > 0),   -- base units per 1 foreign unit × 1e9
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, currency, rate_date)
);

-- ───────────────────────── Fiscal periods ─────────────────────────
CREATE TABLE fiscal_years (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  CHECK (end_date > start_date),
  UNIQUE (company_id, start_date),
  UNIQUE (company_id, id)
);

CREATE TABLE fiscal_periods (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked')),
  locked_by TEXT REFERENCES users(id),
  locked_at TEXT,
  CHECK (end_date >= start_date),
  UNIQUE (company_id, start_date),
  FOREIGN KEY (company_id, fiscal_year_id) REFERENCES fiscal_years(company_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_periods_range ON fiscal_periods(company_id, start_date, end_date);

-- ───────────────────────── Chart of accounts ─────────────────────────
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  subtype TEXT NOT NULL,
  parent_id TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  system_key TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, code),
  UNIQUE (company_id, system_key),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, parent_id) REFERENCES accounts(company_id, id)
);
CREATE INDEX idx_accounts_company ON accounts(company_id, type);

-- ───────────────────────── Contacts (customers / suppliers) ─────────────────────────
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('customer','supplier','both')),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  tax_id TEXT,
  pan TEXT,
  state_code TEXT,
  country TEXT,
  billing_address TEXT,
  shipping_address TEXT,
  currency TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  credit_limit INTEGER,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, id)
);
CREATE INDEX idx_contacts_company ON contacts(company_id, kind, name);

-- ───────────────────────── Tax codes ─────────────────────────
CREATE TABLE tax_codes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scheme TEXT NOT NULL CHECK (scheme IN ('in_gst','simple','none')),
  rate_bp INTEGER NOT NULL CHECK (rate_bp >= 0 AND rate_bp <= 100000),  -- basis points: 1800 = 18%
  category TEXT NOT NULL DEFAULT 'standard' CHECK (category IN ('standard','zero','exempt','nil','non_gst','reverse_charge')),
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, name),
  UNIQUE (company_id, id)
);

-- ───────────────────────── Journals ─────────────────────────
CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entry_number TEXT,
  entry_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
  kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','adjustment','opening','system','reversal','depreciation')),
  memo TEXT,
  reference TEXT,
  source_type TEXT,
  source_id TEXT,
  reversal_of_id TEXT,
  reversed_by_id TEXT,
  idempotency_key TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  branch_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  posted_by TEXT REFERENCES users(id),
  posted_at TEXT,
  UNIQUE (company_id, id),
  UNIQUE (company_id, entry_number),
  UNIQUE (company_id, idempotency_key),
  FOREIGN KEY (company_id, reversal_of_id) REFERENCES journal_entries(company_id, id),
  FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id)
);
CREATE INDEX idx_je_company_date ON journal_entries(company_id, status, entry_date);
CREATE UNIQUE INDEX uq_je_source ON journal_entries(company_id, source_type, source_id)
  WHERE source_type IS NOT NULL AND kind <> 'reversal';
CREATE UNIQUE INDEX uq_je_reversal_of ON journal_entries(reversal_of_id) WHERE reversal_of_id IS NOT NULL;

CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  description TEXT,
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  currency TEXT,                 -- transaction currency (NULL = base)
  fx_rate_scaled INTEGER,        -- rate used to convert amount_fc to base
  amount_fc INTEGER,             -- amount in transaction currency (same side as debit/credit)
  contact_id TEXT,
  department_id TEXT,
  project_id TEXT,
  cost_centre_id TEXT,
  branch_id TEXT,
  tax_code_id TEXT,
  CHECK ((debit = 0) <> (credit = 0)),
  UNIQUE (entry_id, line_no),
  FOREIGN KEY (company_id, entry_id) REFERENCES journal_entries(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, account_id) REFERENCES accounts(company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, id),
  FOREIGN KEY (company_id, department_id) REFERENCES departments(company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id),
  FOREIGN KEY (company_id, cost_centre_id) REFERENCES cost_centres(company_id, id),
  FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id),
  FOREIGN KEY (company_id, tax_code_id) REFERENCES tax_codes(company_id, id)
);
CREATE INDEX idx_jl_entry ON journal_lines(entry_id);
CREATE INDEX idx_jl_account ON journal_lines(company_id, account_id);
CREATE INDEX idx_jl_contact ON journal_lines(company_id, contact_id);

-- Lines of a posted entry are immutable.
CREATE TRIGGER trg_jl_insert_guard BEFORE INSERT ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: cannot add lines to a posted journal')
  WHERE (SELECT status FROM journal_entries WHERE id = NEW.entry_id) = 'posted';
  SELECT RAISE(ABORT, 'TENANT_MISMATCH: line company differs from entry company')
  WHERE (SELECT company_id FROM journal_entries WHERE id = NEW.entry_id) IS NOT NEW.company_id;
END;

CREATE TRIGGER trg_jl_update_guard BEFORE UPDATE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: posted journal lines cannot be edited')
  WHERE (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'posted';
END;

CREATE TRIGGER trg_jl_delete_guard BEFORE DELETE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: posted journal lines cannot be deleted')
  WHERE (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'posted';
END;

-- Posting validation: balanced, ≥2 lines, open period, valid postable accounts.
CREATE TRIGGER trg_je_post_validate BEFORE UPDATE OF status ON journal_entries
WHEN NEW.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'ALREADY_POSTED: journal entry is already posted')
  WHERE OLD.status <> 'draft';
  SELECT RAISE(ABORT, 'TOO_FEW_LINES: a journal needs at least two lines')
  WHERE (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.id) < 2;
  SELECT RAISE(ABORT, 'UNBALANCED: total debits must equal total credits')
  WHERE (SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) FROM journal_lines WHERE entry_id = NEW.id) <> 0;
  SELECT RAISE(ABORT, 'PERIOD_CLOSED: no open fiscal period covers the entry date')
  WHERE NOT EXISTS (
    SELECT 1 FROM fiscal_periods p
    WHERE p.company_id = NEW.company_id AND p.status = 'open'
      AND NEW.entry_date BETWEEN p.start_date AND p.end_date);
  SELECT RAISE(ABORT, 'INVALID_ACCOUNT: lines must use active, non-group accounts')
  WHERE EXISTS (
    SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.entry_id = NEW.id AND (a.is_group = 1 OR a.is_active = 0 OR a.company_id <> NEW.company_id));
  SELECT RAISE(ABORT, 'TOTAL_MISMATCH: header total must equal sum of debits')
  WHERE NEW.total <> (SELECT COALESCE(SUM(debit),0) FROM journal_lines WHERE entry_id = NEW.id);
END;

-- Posted headers are immutable except for linking a reversal once.
CREATE TRIGGER trg_je_posted_immutable BEFORE UPDATE ON journal_entries
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: posted journal entries cannot be edited; use a reversal')
  WHERE NEW.status IS NOT OLD.status
     OR NEW.entry_number IS NOT OLD.entry_number
     OR NEW.entry_date IS NOT OLD.entry_date
     OR NEW.company_id IS NOT OLD.company_id
     OR NEW.kind IS NOT OLD.kind
     OR NEW.memo IS NOT OLD.memo
     OR NEW.reference IS NOT OLD.reference
     OR NEW.source_type IS NOT OLD.source_type
     OR NEW.source_id IS NOT OLD.source_id
     OR NEW.reversal_of_id IS NOT OLD.reversal_of_id
     OR NEW.idempotency_key IS NOT OLD.idempotency_key
     OR NEW.total IS NOT OLD.total
     OR NEW.branch_id IS NOT OLD.branch_id
     OR NEW.created_by IS NOT OLD.created_by
     OR NEW.created_at IS NOT OLD.created_at
     OR NEW.posted_by IS NOT OLD.posted_by
     OR NEW.posted_at IS NOT OLD.posted_at
     OR (OLD.reversed_by_id IS NOT NULL AND NEW.reversed_by_id IS NOT OLD.reversed_by_id);
END;

CREATE TRIGGER trg_je_delete_guard BEFORE DELETE ON journal_entries
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: posted journal entries cannot be deleted');
END;

-- Period locking cannot be bypassed by changing a draft's date on a locked period at post time
-- (enforced above) and locked periods cannot be edited back to a different range.
CREATE TRIGGER trg_period_range_guard BEFORE UPDATE OF start_date, end_date ON fiscal_periods
BEGIN
  SELECT RAISE(ABORT, 'PERIOD_IMMUTABLE: period dates cannot be changed');
END;

-- ───────────────────────── Audit log (append-only) ─────────────────────────
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  company_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_company ON audit_logs(company_id, created_at);
CREATE INDEX idx_audit_org ON audit_logs(org_id, created_at);

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE: audit log is append-only'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE: audit log is append-only'); END;
