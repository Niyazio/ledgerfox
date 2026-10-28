-- Malayalam and Kannada bill labels. The original print_language column only allows en/hi/ta (a CHECK that SQLite
-- cannot change in place), so the chosen language is kept in a new column; print_language stays as a fallback.
-- Additive only.
ALTER TABLE companies ADD COLUMN print_lang TEXT CHECK (print_lang IS NULL OR print_lang IN ('en','hi','ta','ml','kn'));
