-- Multi-branch access control, seven default roles with per-organisation customisation, approvals, product codes,
-- branch stock transfers and query indexes. Existing data is preserved; tables are rebuilt only to widen role checks.

-- Memberships: new roles + whether the member may see every branch (true for existing members, so nobody loses access).
CREATE TABLE memberships_new (
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','billing','purchase','accountant','inventory','auditor','viewer')),
  all_branches INTEGER NOT NULL DEFAULT 1 CHECK (all_branches IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (org_id, user_id)
);
INSERT INTO memberships_new (org_id, user_id, role, all_branches, created_at) SELECT org_id, user_id, role, 1, created_at FROM memberships;
DROP TABLE memberships;
ALTER TABLE memberships_new RENAME TO memberships;
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE invitations_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','billing','purchase','accountant','inventory','auditor','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO invitations_new SELECT id, org_id, email, role, token_hash, invited_by, expires_at, accepted_at, revoked_at, created_at FROM invitations;
DROP TABLE invitations;
ALTER TABLE invitations_new RENAME TO invitations;
CREATE INDEX idx_invitations_org ON invitations(org_id);

-- Branches a member may use when not allowed all branches.
CREATE TABLE member_branches (
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id, branch_id),
  FOREIGN KEY (company_id, branch_id) REFERENCES branches(company_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_member_branches_user ON member_branches(user_id, company_id);

-- Owner customisations of the default role permissions (Owner itself is never customisable).
CREATE TABLE role_permissions (
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','billing','purchase','accountant','inventory','auditor','viewer')),
  permission TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),
  PRIMARY KEY (org_id, role, permission)
);

-- Branch profile and numbering.
ALTER TABLE branches ADD COLUMN invoice_prefix TEXT;
ALTER TABLE branches ADD COLUMN phone TEXT;
ALTER TABLE branches ADD COLUMN gstin TEXT;

-- Branch on payments and expenses (documents and journals already carry one).
ALTER TABLE payments ADD COLUMN branch_id TEXT;
ALTER TABLE expenses ADD COLUMN branch_id TEXT;
CREATE INDEX idx_payments_branch ON payments(company_id, branch_id);
CREATE INDEX idx_expenses_branch ON expenses(company_id, branch_id);
CREATE INDEX idx_documents_branch ON documents(company_id, branch_id);

-- Approval limits (NULL = no limit) and approvals of individual documents.
ALTER TABLE companies ADD COLUMN purchase_approval_limit INTEGER;
ALTER TABLE companies ADD COLUMN billing_discount_limit_bp INTEGER;
CREATE TABLE document_approvals (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_by TEXT,
  approved_at TEXT,
  note TEXT
);

-- Product identification: unique internal code (QR) and optional barcode per company.
ALTER TABLE items ADD COLUMN code TEXT;
ALTER TABLE items ADD COLUMN barcode TEXT;
UPDATE items SET code = 'P' || printf('%06d', rowid) WHERE code IS NULL;
CREATE UNIQUE INDEX idx_items_code ON items(company_id, code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX idx_items_barcode ON items(company_id, barcode) WHERE barcode IS NOT NULL;

-- Stock transfers record both branches (derived from the warehouses at the time of transfer).
CREATE TABLE stock_transfers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  value INTEGER NOT NULL,
  from_warehouse_id TEXT NOT NULL,
  to_warehouse_id TEXT NOT NULL,
  from_branch_id TEXT,
  to_branch_id TEXT,
  transfer_date TEXT NOT NULL,
  memo TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_stock_transfers_company ON stock_transfers(company_id, transfer_date);
CREATE TRIGGER trg_stock_transfers_immutable_u BEFORE UPDATE ON stock_transfers
BEGIN SELECT RAISE(ABORT, 'STOCK_IMMUTABLE: transfers are append-only'); END;
CREATE TRIGGER trg_stock_transfers_immutable_d BEFORE DELETE ON stock_transfers
WHEN NOT EXISTS (SELECT 1 FROM company_purge WHERE company_id = OLD.company_id)
BEGIN SELECT RAISE(ABORT, 'STOCK_IMMUTABLE: transfers are append-only'); END;

-- Audit history lookups per record (daybook / history panel).
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id, created_at);
