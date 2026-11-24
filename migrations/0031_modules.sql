-- Features each company switches on or off (Settings → Features). NULL = everything on, so existing companies are
-- unchanged. Additive only.
ALTER TABLE companies ADD COLUMN modules_off TEXT;
