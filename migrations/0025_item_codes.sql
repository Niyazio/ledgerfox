-- Products created with a new company (starter items) had no product code, so their QR labels and scanning did not
-- work. Give every product without a code the next free P000123-style code of its company. Additive: only empty
-- codes are filled; nothing else changes.
CREATE TABLE _lf_item_codes AS
  SELECT id, company_id, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at, id) AS rn FROM items WHERE code IS NULL;
CREATE TABLE _lf_item_code_base AS
  SELECT company_id, MAX(CAST(SUBSTR(code, 2) AS INTEGER)) AS base FROM items WHERE code GLOB 'P[0-9]*' GROUP BY company_id;
UPDATE items SET code = (
  SELECT 'P' || printf('%06d', COALESCE((SELECT b.base FROM _lf_item_code_base b WHERE b.company_id = items.company_id), 0) + m.rn)
  FROM _lf_item_codes m WHERE m.id = items.id
) WHERE code IS NULL;
DROP TABLE _lf_item_codes;
DROP TABLE _lf_item_code_base;
