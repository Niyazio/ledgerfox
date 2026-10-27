-- Auto-renewing subscriptions (Razorpay Subscriptions: UPI AutoPay, card and e-mandate) and Free-plan promotions.
-- Additive only.

-- Razorpay plan ids created by LedgerFox, one per plan, interval and price including GST.
CREATE TABLE billing_rzp_plans (
  plan_key TEXT PRIMARY KEY,              -- e.g. business:monthly:94300
  razorpay_plan_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The organisation's auto-renewal, if any. Paid periods still live in paid_until; this only says who charges next.
ALTER TABLE org_subscriptions ADD COLUMN autopay_id TEXT;              -- Razorpay subscription id (sub_...)
ALTER TABLE org_subscriptions ADD COLUMN autopay_status TEXT;          -- created, active, pending, halted, cancelled, completed
ALTER TABLE org_subscriptions ADD COLUMN autopay_plan TEXT;
ALTER TABLE org_subscriptions ADD COLUMN autopay_interval TEXT;
ALTER TABLE org_subscriptions ADD COLUMN autopay_total INTEGER;        -- amount charged each period, paise, with GST
CREATE UNIQUE INDEX idx_org_subscriptions_autopay ON org_subscriptions(autopay_id) WHERE autopay_id IS NOT NULL;

ALTER TABLE billing_payments ADD COLUMN provider_subscription_id TEXT;

-- Small cards shown to organisations on the Free plan of the hosted edition (never to paying, trial or desktop users).
-- Plain text and a link: no third-party scripts, images or trackers run inside the app.
CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  cta TEXT NOT NULL DEFAULT 'Learn more',
  link_url TEXT NOT NULL,                 -- https:// only, checked by the server
  sponsor TEXT,                           -- shown as "Sponsored by …"; NULL for LedgerFox's own messages
  is_active INTEGER NOT NULL DEFAULT 1,
  starts_on TEXT,
  ends_on TEXT,
  weight INTEGER NOT NULL DEFAULT 1,
  views INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
