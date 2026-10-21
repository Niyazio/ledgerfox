-- Price lists (wholesale, dealer, retail…): per-item prices with quantity breaks, or a percentage on the selling price
-- for items the list does not name. Customers may be linked to one list. Additive only.
CREATE TABLE price_lists (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  adjust_bp INTEGER NOT NULL DEFAULT 0 CHECK (adjust_bp BETWEEN -10000 AND 100000), -- -10 % = -1000; +5 % = 500
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (company_id, name),
  UNIQUE (company_id, id)
);
CREATE TABLE price_list_prices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  price_list_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  min_qty_milli INTEGER NOT NULL DEFAULT 0 CHECK (min_qty_milli >= 0),
  price INTEGER NOT NULL CHECK (price >= 0),
  UNIQUE (price_list_id, item_id, min_qty_milli),
  FOREIGN KEY (company_id, price_list_id) REFERENCES price_lists(company_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_price_list_prices_item ON price_list_prices(price_list_id, item_id);
ALTER TABLE contacts ADD COLUMN price_list_id TEXT REFERENCES price_lists(id);
