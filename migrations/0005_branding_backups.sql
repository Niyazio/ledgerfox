-- Company logo and payment QR (kept out of `companies` so ordinary requests do not load images), and encrypted cloud
-- backups of desktop data files.

CREATE TABLE company_branding (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  logo TEXT,           -- data:image/...;base64, resized in the browser (≤ 300 KB)
  payment_qr TEXT,     -- the business's own UPI / payment QR image (≤ 300 KB)
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Backups are encrypted on the user's computer before upload (AES-GCM, key from a passphrase only the user knows),
-- so the server stores opaque bytes. Kept per user; the newest few are retained.
CREATE TABLE cloud_backups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','complete')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_cloud_backups_user ON cloud_backups(user_id, created_at);

CREATE TABLE cloud_backup_chunks (
  backup_id TEXT NOT NULL REFERENCES cloud_backups(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  data BLOB NOT NULL,
  PRIMARY KEY (backup_id, idx)
) WITHOUT ROWID;

-- Long-lived, revocable keys a desktop app uses for automatic backups (scope 'backup' only; stored hashed).
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('backup')),
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);
