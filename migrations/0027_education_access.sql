-- Education mode by invitation: LedgerFox approves the emails (teacher, institute, trainer) that may run practice
-- companies, and each such organisation is limited to a number of devices — 10 free, or a 25 / 50 / 100 student pack
-- for 6 months. Additive only: existing companies and data are untouched.
CREATE TABLE education_access (
  email TEXT PRIMARY KEY,                       -- lower case
  devices INTEGER NOT NULL DEFAULT 10 CHECK (devices BETWEEN 1 AND 1000),
  pack TEXT CHECK (pack IS NULL OR pack IN ('edu25', 'edu50', 'edu100')),
  pack_until TEXT,                              -- the pack's devices apply until then; afterwards back to `devices`
  note TEXT,
  granted_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT
);

-- Devices (browser, desktop app or phone) that have opened an organisation's practice company.
CREATE TABLE education_devices (
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  label TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, device_id)
);
