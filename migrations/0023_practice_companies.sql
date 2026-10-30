-- Education mode: "practice" companies are free with every feature, for learning only. Like Tally's educational
-- mode, entries may be dated only the 1st, 2nd or last day of a month, so they cannot be used to run a business.
-- Additive only.
ALTER TABLE companies ADD COLUMN is_practice INTEGER NOT NULL DEFAULT 0 CHECK (is_practice IN (0,1));

CREATE TRIGGER trg_practice_dates_insert BEFORE INSERT ON journal_entries
WHEN (SELECT is_practice FROM companies WHERE id = NEW.company_id) = 1
  AND CAST(strftime('%d', NEW.entry_date) AS INTEGER) NOT IN (1, 2, CAST(strftime('%d', NEW.entry_date, 'start of month', '+1 month', '-1 day') AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'PRACTICE_DATE: A practice company accepts entries dated only the 1st, 2nd or last day of a month (education mode)');
END;

CREATE TRIGGER trg_practice_dates_update BEFORE UPDATE OF entry_date ON journal_entries
WHEN (SELECT is_practice FROM companies WHERE id = NEW.company_id) = 1
  AND CAST(strftime('%d', NEW.entry_date) AS INTEGER) NOT IN (1, 2, CAST(strftime('%d', NEW.entry_date, 'start of month', '+1 month', '-1 day') AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'PRACTICE_DATE: A practice company accepts entries dated only the 1st, 2nd or last day of a month (education mode)');
END;
