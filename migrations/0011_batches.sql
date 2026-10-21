-- Batch numbers and expiry dates (pharmacy, food, FMCG). Additive only. Costing stays moving-average per item;
-- batches track quantity and expiry.
ALTER TABLE items ADD COLUMN track_batches INTEGER NOT NULL DEFAULT 0 CHECK (track_batches IN (0,1));
ALTER TABLE stock_moves ADD COLUMN batch_no TEXT;
ALTER TABLE stock_moves ADD COLUMN expiry_date TEXT;
CREATE INDEX idx_stock_moves_batch ON stock_moves(company_id, item_id, warehouse_id, batch_no);
ALTER TABLE document_lines ADD COLUMN batch_no TEXT;
ALTER TABLE document_lines ADD COLUMN expiry_date TEXT;
