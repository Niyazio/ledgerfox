-- Two-factor sign-in with an authenticator app (TOTP). Additive only.
ALTER TABLE users ADD COLUMN totp_secret TEXT;           -- base32; set while enrolling, kept while enabled
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0,1));
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;     -- last accepted time step (codes cannot be reused)
-- Owners can require two-factor sign-in for everyone in the organisation.
ALTER TABLE organisations ADD COLUMN require_2fa INTEGER NOT NULL DEFAULT 0 CHECK (require_2fa IN (0,1));
