-- TDS deducted on payments (by us from suppliers, or by customers from us) and GST reverse charge on bills.
-- Additive only.
ALTER TABLE payments ADD COLUMN tds_amount INTEGER NOT NULL DEFAULT 0 CHECK (tds_amount >= 0);
ALTER TABLE payments ADD COLUMN tds_section TEXT;
ALTER TABLE documents ADD COLUMN reverse_charge INTEGER NOT NULL DEFAULT 0 CHECK (reverse_charge IN (0,1));

-- The allocation check now lets a payment settle its cash amount plus the TDS deducted. Same trigger, one condition
-- changed; triggers hold no data.
DROP TRIGGER trg_alloc_validate;
CREATE TRIGGER trg_alloc_validate BEFORE INSERT ON allocations
BEGIN
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: negative allocations must reverse an existing allocation')
  WHERE NEW.amount < 0 AND (NEW.reverses_id IS NULL OR
    (SELECT amount FROM allocations WHERE id = NEW.reverses_id) <> -NEW.amount);
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: target must be a posted invoice or bill')
  WHERE (SELECT doc_type FROM documents WHERE id = NEW.document_id) NOT IN ('invoice','bill')
     OR (SELECT status FROM documents WHERE id = NEW.document_id) <> 'posted';
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: payment direction does not match document')
  WHERE NEW.payment_id IS NOT NULL AND NOT (
    ((SELECT direction FROM payments WHERE id = NEW.payment_id) = 'in'  AND (SELECT doc_type FROM documents WHERE id = NEW.document_id) = 'invoice') OR
    ((SELECT direction FROM payments WHERE id = NEW.payment_id) = 'out' AND (SELECT doc_type FROM documents WHERE id = NEW.document_id) = 'bill'));
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: payment currency or contact does not match document')
  WHERE NEW.payment_id IS NOT NULL AND (
    (SELECT currency FROM payments WHERE id = NEW.payment_id) <> (SELECT currency FROM documents WHERE id = NEW.document_id) OR
    (SELECT contact_id FROM payments WHERE id = NEW.payment_id) <> (SELECT contact_id FROM documents WHERE id = NEW.document_id));
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: payment is void')
  WHERE NEW.payment_id IS NOT NULL AND NEW.amount > 0 AND (SELECT status FROM payments WHERE id = NEW.payment_id) <> 'posted';
  SELECT RAISE(ABORT, 'OVER_ALLOCATED: allocations exceed the payment amount (plus TDS)')
  WHERE NEW.payment_id IS NOT NULL AND
    (SELECT COALESCE(SUM(amount),0) FROM allocations WHERE payment_id = NEW.payment_id) + NEW.amount
      > (SELECT amount + tds_amount FROM payments WHERE id = NEW.payment_id);
  SELECT RAISE(ABORT, 'ALLOCATION_INVALID: note does not match document')
  WHERE NEW.note_id IS NOT NULL AND NOT (
    (SELECT status FROM documents WHERE id = NEW.note_id) = 'posted' AND
    (SELECT contact_id FROM documents WHERE id = NEW.note_id) = (SELECT contact_id FROM documents WHERE id = NEW.document_id) AND
    (SELECT currency FROM documents WHERE id = NEW.note_id) = (SELECT currency FROM documents WHERE id = NEW.document_id) AND (
      ((SELECT doc_type FROM documents WHERE id = NEW.note_id) = 'credit_note' AND (SELECT doc_type FROM documents WHERE id = NEW.document_id) = 'invoice') OR
      ((SELECT doc_type FROM documents WHERE id = NEW.note_id) = 'debit_note'  AND (SELECT doc_type FROM documents WHERE id = NEW.document_id) = 'bill')));
END;
