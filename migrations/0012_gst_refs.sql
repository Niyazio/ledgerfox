-- e-invoice (IRN) and e-way bill references recorded against a document after the user generates them on the
-- government portals. Kept in their own table so posted documents stay untouched. Additive only.
CREATE TABLE document_gst_refs (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  irn TEXT,                 -- 64-character invoice reference number from the IRP
  ack_no TEXT,
  ack_date TEXT,
  signed_qr TEXT,           -- signed QR code text from the IRP (printed as a QR on the invoice)
  irn_cancelled INTEGER NOT NULL DEFAULT 0 CHECK (irn_cancelled IN (0,1)),
  ewb_no TEXT,              -- 12-digit e-way bill number
  ewb_date TEXT,
  ewb_valid_until TEXT,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_gst_refs_company ON document_gst_refs(company_id);
