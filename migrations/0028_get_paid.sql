-- Getting paid: customers pay invoices online through the business's own Razorpay account, see their invoices in a
-- customer portal, and get automatic payment reminders. Additive only.

-- One row per company. Razorpay secrets are stored encrypted (AES-GCM with the DATA_KEY Worker secret), never in plain text.
CREATE TABLE collection_settings (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  online_enabled INTEGER NOT NULL DEFAULT 0 CHECK (online_enabled IN (0,1)),
  razorpay_key_id TEXT,
  razorpay_secret_enc TEXT,
  razorpay_webhook_secret_enc TEXT,
  deposit_account_id TEXT,                    -- cash/bank account online receipts are posted to
  reminders_enabled INTEGER NOT NULL DEFAULT 0 CHECK (reminders_enabled IN (0,1)),
  remind_before_days INTEGER NOT NULL DEFAULT 3 CHECK (remind_before_days BETWEEN 0 AND 30),
  remind_on_due INTEGER NOT NULL DEFAULT 1 CHECK (remind_on_due IN (0,1)),
  remind_every_days INTEGER NOT NULL DEFAULT 7 CHECK (remind_every_days BETWEEN 1 AND 60),
  remind_max_after INTEGER NOT NULL DEFAULT 3 CHECK (remind_max_after BETWEEN 0 AND 12),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Online payment attempts for an invoice (a Razorpay order), and the receipt they became.
CREATE TABLE online_payments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  provider_order_id TEXT NOT NULL UNIQUE,
  provider_payment_id TEXT UNIQUE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  payment_id TEXT,                            -- the receipt recorded for it
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT
);
CREATE INDEX idx_online_payments_doc ON online_payments(document_id);

-- Customer portal: one private link per customer.
CREATE TABLE portal_links (
  token TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_opened_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_portal_links_contact ON portal_links(company_id, contact_id);

-- Reminders already sent, so each one goes out once.
CREATE TABLE invoice_reminders (
  document_id TEXT NOT NULL,
  kind TEXT NOT NULL,                         -- before, due, after1, after2…
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_to TEXT,
  PRIMARY KEY (document_id, kind)
);
