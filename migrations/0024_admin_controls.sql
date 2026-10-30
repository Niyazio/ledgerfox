-- Admin panel controls: pausing an organisation, accepted terms, and a history of billing events. Additive only.
ALTER TABLE organisations ADD COLUMN suspended_at TEXT;
ALTER TABLE organisations ADD COLUMN suspended_reason TEXT;
ALTER TABLE users ADD COLUMN terms_accepted_at TEXT;

-- Everything that happened to an organisation's subscription: trial, auto-pay set up / approved / charged / cancelled,
-- payments, free access given by the vendor, pauses. Shown in the admin panel.
CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  user_id TEXT,
  kind TEXT NOT NULL,
  details TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_billing_events_org ON billing_events(org_id, created_at);
CREATE INDEX idx_billing_events_time ON billing_events(created_at);

-- History so far, from the audit trail and the payments already recorded.
INSERT INTO billing_events (id, org_id, user_id, kind, details, actor, created_at)
  SELECT 'a-' || id, org_id, user_id, substr(action, 9), details, 'history', created_at FROM audit_logs WHERE action LIKE 'billing.%';
INSERT INTO billing_events (id, org_id, kind, details, actor, created_at)
  SELECT 'p-' || id, org_id, 'payment', json_object('plan', plan, 'interval', billing_interval, 'total', total, 'provider', provider, 'payment_id', provider_payment_id, 'invoice', invoice_number), 'history', COALESCE(paid_at, created_at)
  FROM billing_payments WHERE status = 'paid';
INSERT INTO billing_events (id, org_id, kind, details, actor, created_at)
  SELECT 't-' || org_id, org_id, 'trial_started', json_object('trial_ends_at', trial_ends_at), 'history', updated_at
  FROM org_subscriptions WHERE trial_ends_at IS NOT NULL;
