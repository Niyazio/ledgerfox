-- Subscriptions for the hosted edition (used only when billing is switched on). Additive only.
CREATE TABLE org_subscriptions (
  org_id TEXT PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','starter','business','multi_branch')),
  billing_interval TEXT CHECK (billing_interval IN ('monthly','yearly')),
  trial_ends_at TEXT,
  paid_until TEXT,                      -- end of the period already paid for (UTC timestamp)
  note TEXT,                            -- e.g. manual activation by the vendor
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE billing_payments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  billing_interval TEXT NOT NULL,
  amount INTEGER NOT NULL,              -- before GST, paise
  gst INTEGER NOT NULL,
  total INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('razorpay','manual')),
  provider_order_id TEXT UNIQUE,
  provider_payment_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  invoice_number TEXT UNIQUE,           -- the vendor's own tax invoice number, set when paid
  period_start TEXT,
  period_end TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT
);
CREATE INDEX idx_billing_payments_org ON billing_payments(org_id, created_at);

CREATE TABLE billing_counters (name TEXT PRIMARY KEY, next_value INTEGER NOT NULL);
