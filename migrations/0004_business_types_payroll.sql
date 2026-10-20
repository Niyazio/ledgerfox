-- Usernames (Tally-style login), business types, demo companies, QR verification, payroll and timesheets.

ALTER TABLE users ADD COLUMN username TEXT COLLATE NOCASE;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_users_username ON users(username) WHERE username IS NOT NULL;

ALTER TABLE companies ADD COLUMN business_type TEXT NOT NULL DEFAULT 'general';
ALTER TABLE companies ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN upi_id TEXT;
ALTER TABLE companies ADD COLUMN print_template TEXT NOT NULL DEFAULT 'modern';

-- Deleting a company is only possible for demo companies: the guards below step aside while a company id is listed here,
-- and only demo companies can be listed.
CREATE TABLE company_purge (company_id TEXT PRIMARY KEY);
CREATE TRIGGER trg_company_purge_demo_only BEFORE INSERT ON company_purge
BEGIN
  SELECT RAISE(ABORT, 'NOT_DEMO: only demo companies can be deleted')
  WHERE COALESCE((SELECT is_demo FROM companies WHERE id = NEW.company_id), 0) <> 1;
END;

DROP TRIGGER trg_jl_delete_guard;
CREATE TRIGGER trg_jl_delete_guard BEFORE DELETE ON journal_lines
WHEN NOT EXISTS (SELECT 1 FROM company_purge WHERE company_id = OLD.company_id)
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: posted journal lines cannot be deleted')
  WHERE (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'posted';
END;

DROP TRIGGER trg_je_delete_guard;
CREATE TRIGGER trg_je_delete_guard BEFORE DELETE ON journal_entries
WHEN OLD.status = 'posted' AND NOT EXISTS (SELECT 1 FROM company_purge WHERE company_id = OLD.company_id)
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: posted journal entries cannot be deleted');
END;

DROP TRIGGER trg_stock_immutable_d;
CREATE TRIGGER trg_stock_immutable_d BEFORE DELETE ON stock_moves
WHEN NOT EXISTS (SELECT 1 FROM company_purge WHERE company_id = OLD.company_id)
BEGIN SELECT RAISE(ABORT, 'STOCK_IMMUTABLE: stock movements are append-only'); END;

DROP TRIGGER trg_doc_delete_guard;
CREATE TRIGGER trg_doc_delete_guard BEFORE DELETE ON documents
WHEN OLD.status NOT IN ('draft') AND NOT EXISTS (SELECT 1 FROM company_purge WHERE company_id = OLD.company_id)
BEGIN SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: only draft documents can be deleted'); END;

DROP TRIGGER trg_docline_guard_d;
CREATE TRIGGER trg_docline_guard_d BEFORE DELETE ON document_lines
WHEN NOT EXISTS (SELECT 1 FROM company_purge WHERE company_id = OLD.company_id)
BEGIN
  SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: lines of a non-draft document cannot change')
  WHERE (SELECT status FROM documents WHERE id = OLD.document_id) NOT IN ('draft');
END;

DROP TRIGGER trg_alloc_no_delete;
CREATE TRIGGER trg_alloc_no_delete BEFORE DELETE ON allocations
WHEN NOT EXISTS (SELECT 1 FROM company_purge WHERE company_id = OLD.company_id)
BEGIN SELECT RAISE(ABORT, 'ALLOCATION_IMMUTABLE'); END;

DROP TRIGGER trg_expense_delete_guard;
CREATE TRIGGER trg_expense_delete_guard BEFORE DELETE ON expenses
WHEN OLD.status = 'posted' AND NOT EXISTS (SELECT 1 FROM company_purge WHERE company_id = OLD.company_id)
BEGIN SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: posted expenses cannot be deleted'); END;

-- Public QR verification: an unguessable token per printed document, payment or payslip.
CREATE TABLE verifications (
  token TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('document','payment','payslip')),
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (entity_type, entity_id)
);

-- Payroll ---------------------------------------------------------------------------------------------------------
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  designation TEXT,
  department_id TEXT,
  email TEXT,
  phone TEXT,
  date_of_joining TEXT,
  date_of_leaving TEXT,
  pan TEXT,
  uan TEXT,
  esi_number TEXT,
  bank_name TEXT,
  bank_account TEXT,
  ifsc TEXT,
  pay_type TEXT NOT NULL DEFAULT 'monthly' CHECK (pay_type IN ('monthly','hourly')),
  monthly_basic INTEGER NOT NULL DEFAULT 0 CHECK (monthly_basic >= 0),
  hra INTEGER NOT NULL DEFAULT 0 CHECK (hra >= 0),
  other_allowances INTEGER NOT NULL DEFAULT 0 CHECK (other_allowances >= 0),
  hourly_rate INTEGER NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
  overtime_rate INTEGER NOT NULL DEFAULT 0 CHECK (overtime_rate >= 0),
  pf_enabled INTEGER NOT NULL DEFAULT 0,
  esi_enabled INTEGER NOT NULL DEFAULT 0,
  pt_monthly INTEGER NOT NULL DEFAULT 0 CHECK (pt_monthly >= 0),
  tds_monthly INTEGER NOT NULL DEFAULT 0 CHECK (tds_monthly >= 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

CREATE TABLE timesheets (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL,
  work_date TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  overtime_minutes INTEGER NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0 AND overtime_minutes <= 1440),
  project_id TEXT,
  description TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id)
);
CREATE INDEX idx_timesheets_emp_date ON timesheets(company_id, employee_id, work_date);

CREATE TABLE payroll_runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  pay_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','paid')),
  journal_entry_id TEXT,
  payment_entry_id TEXT,
  gross INTEGER NOT NULL DEFAULT 0,
  deductions INTEGER NOT NULL DEFAULT 0,
  net INTEGER NOT NULL DEFAULT 0,
  employer_cost INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, period),
  UNIQUE (company_id, id)
);

CREATE TABLE payslips (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  working_days INTEGER NOT NULL,
  paid_days_milli INTEGER NOT NULL,
  worked_minutes INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  basic INTEGER NOT NULL DEFAULT 0,
  hra INTEGER NOT NULL DEFAULT 0,
  allowances INTEGER NOT NULL DEFAULT 0,
  overtime INTEGER NOT NULL DEFAULT 0,
  gross INTEGER NOT NULL DEFAULT 0,
  pf_employee INTEGER NOT NULL DEFAULT 0,
  esi_employee INTEGER NOT NULL DEFAULT 0,
  pt INTEGER NOT NULL DEFAULT 0,
  tds INTEGER NOT NULL DEFAULT 0,
  other_deductions INTEGER NOT NULL DEFAULT 0,
  total_deductions INTEGER NOT NULL DEFAULT 0,
  net INTEGER NOT NULL DEFAULT 0,
  pf_employer INTEGER NOT NULL DEFAULT 0,
  esi_employer INTEGER NOT NULL DEFAULT 0,
  CHECK (net = gross - total_deductions),
  CHECK (total_deductions = pf_employee + esi_employee + pt + tds + other_deductions),
  UNIQUE (run_id, employee_id),
  FOREIGN KEY (company_id, run_id) REFERENCES payroll_runs(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, employee_id) REFERENCES employees(company_id, id)
);

-- Payslips are frozen once their run is posted.
CREATE TRIGGER trg_payslip_frozen_u BEFORE UPDATE ON payslips
WHEN (SELECT status FROM payroll_runs WHERE id = OLD.run_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: payslips of a posted payroll cannot change'); END;
CREATE TRIGGER trg_payslip_frozen_d BEFORE DELETE ON payslips
WHEN (SELECT status FROM payroll_runs WHERE id = OLD.run_id) <> 'draft'
  AND NOT EXISTS (SELECT 1 FROM company_purge WHERE company_id = OLD.company_id)
BEGIN SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: payslips of a posted payroll cannot change'); END;
CREATE TRIGGER trg_payroll_run_delete BEFORE DELETE ON payroll_runs
WHEN OLD.status <> 'draft' AND NOT EXISTS (SELECT 1 FROM company_purge WHERE company_id = OLD.company_id)
BEGIN SELECT RAISE(ABORT, 'POSTED_IMMUTABLE: posted payroll cannot be deleted'); END;
