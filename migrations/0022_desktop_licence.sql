-- Desktop app licensing: the desktop app signs in to the customer's LedgerFox online account and receives a signed
-- licence for that organisation's plan (trial, Starter, Business…). Additive only.

-- Website: the Ed25519 key that signs licences (created on first use; the public half is published).
CREATE TABLE licence_keys (
  id TEXT PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Website: computers signed in to an organisation (only a hash of each computer's token is kept).
CREATE TABLE desktop_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_desktop_devices_org ON desktop_devices(org_id);

-- Desktop app: the licence this computer holds (one row).
CREATE TABLE desktop_licence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server TEXT NOT NULL,
  token TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  device_token TEXT NOT NULL,
  account_email TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
