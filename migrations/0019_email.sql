-- Email: address verification, self-service password reset by email, and billing notices sent once. Additive only.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

-- One-time links mailed to a user (only the SHA-256 of the token is stored).
CREATE TABLE email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify')),
  email TEXT NOT NULL,                  -- the address the link was sent to; must still match when used
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_email_tokens_user ON email_tokens(user_id);

-- Reminders and alerts already sent, so the daily job never sends the same one twice.
CREATE TABLE billing_notices (
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  notice_key TEXT NOT NULL,             -- e.g. trial-end:2026-11-10, renew:2027-10-27, autopay-halted:sub_x
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, notice_key)
);
