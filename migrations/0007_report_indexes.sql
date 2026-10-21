-- Covering indexes for ledger aggregation (reports, dashboard, aging reconciliation). Additive only: no data changes.
-- Posted entries by date can be read from the index alone, and each entry's lines likewise.
CREATE INDEX IF NOT EXISTS idx_je_posted_cover ON journal_entries(company_id, status, entry_date, id);
CREATE INDEX IF NOT EXISTS idx_jl_entry_cover ON journal_lines(entry_id, account_id, debit, credit, branch_id, contact_id);
-- Settled amounts per document as of a date (aging).
CREATE INDEX IF NOT EXISTS idx_alloc_doc_cover ON allocations(document_id, allocation_date, amount);
