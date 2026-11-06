-- Customising: custom fields, reports emailed on a schedule, and automation rules (email / webhook). Additive only.

-- Extra fields a business adds to its sales documents, purchase documents, customers & suppliers, or products.
CREATE TABLE custom_fields (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity TEXT NOT NULL CHECK (entity IN ('sales','purchase','contact','item')),
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text' CHECK (field_type IN ('text','number','date','select','checkbox')),
  options TEXT,                               -- JSON list for "select"
  show_on_print INTEGER NOT NULL DEFAULT 1 CHECK (show_on_print IN (0,1)),
  sort INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_custom_fields ON custom_fields(company_id, entity, sort);

CREATE TABLE custom_values (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (field_id, entity_id)
);
CREATE INDEX idx_custom_values_entity ON custom_values(company_id, entity_id);

-- Reports emailed automatically.
CREATE TABLE report_schedules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report TEXT NOT NULL CHECK (report IN ('daily-summary','profit-loss','receivables','payables','stock')),
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  weekday INTEGER NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),   -- weekly: 0 = Sunday
  recipients TEXT NOT NULL,                   -- comma-separated emails
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by TEXT,
  last_sent_on TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_report_schedules ON report_schedules(company_id);

-- "When this happens, do that": an email or a signed webhook call.
CREATE TABLE automation_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('invoice.issued','bill.issued','payment.received','payment.made','quote.accepted','quote.declined','invoice.paid_online')),
  min_amount INTEGER,                         -- only when the amount (base currency) is at least this
  action TEXT NOT NULL CHECK (action IN ('email','webhook')),
  target TEXT NOT NULL,                       -- email address(es) or https URL
  secret_enc TEXT,                            -- webhook signing secret (encrypted when DATA_KEY is set)
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_automation_rules ON automation_rules(company_id, event);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  entity_id TEXT,
  ok INTEGER NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_automation_runs ON automation_runs(rule_id, created_at);
