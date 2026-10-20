-- Replay protection for client retries (offline outbox, flaky networks).
-- A POST carrying an Idempotency-Key header is processed once per (company, user, key); a repeat returns the stored
-- response. status IS NULL marks a request still in flight.
CREATE TABLE idempotency_keys (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  response TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, user_id, key)
) WITHOUT ROWID;
CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);
