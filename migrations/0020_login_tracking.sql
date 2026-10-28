-- Sign-in tracking for the vendor's admin panel. Additive only.
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0;
