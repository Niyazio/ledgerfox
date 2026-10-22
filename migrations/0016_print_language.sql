-- Language of printed bills: English, or English with Hindi / Tamil labels. Additive only.
ALTER TABLE companies ADD COLUMN print_language TEXT NOT NULL DEFAULT 'en' CHECK (print_language IN ('en','hi','ta'));
