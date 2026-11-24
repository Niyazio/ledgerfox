-- Education mode: how many practice companies each approved email may create (set by LedgerFox in the admin panel).
-- Additive only; everyone approved so far keeps the one company they were allowed.
ALTER TABLE education_access ADD COLUMN max_companies INTEGER NOT NULL DEFAULT 1 CHECK (max_companies BETWEEN 1 AND 500);
