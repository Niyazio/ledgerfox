-- CRM: leads moving through a pipeline, with calls, meetings, notes and follow-up tasks; a lead becomes a customer and a quotation.
CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  person TEXT,
  organisation TEXT,
  phone TEXT,
  email TEXT,
  source TEXT,
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new','contacted','qualified','proposal','won','lost')),
  value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  currency TEXT NOT NULL,
  expected_close TEXT,
  owner_user_id TEXT,
  notes TEXT,
  lost_reason TEXT,
  contact_id TEXT,
  quote_id TEXT,
  closed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, id)
);
CREATE INDEX idx_leads_company ON leads(company_id, stage, updated_at);
CREATE TABLE lead_activities (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('call','meeting','email','whatsapp','note','task')),
  summary TEXT NOT NULL,
  due_date TEXT,
  done_at TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_lead_activities_due ON lead_activities(company_id, done_at, due_date);
