-- International subscriptions: the currency of each payment and of an auto-pay subscription (existing rows are INR).
ALTER TABLE billing_payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE org_subscriptions ADD COLUMN autopay_currency TEXT NOT NULL DEFAULT 'INR';

-- Bills can also print English + Arabic (Gulf countries). A new column, because the older ones only allow Indian languages.
ALTER TABLE companies ADD COLUMN bill_lang TEXT CHECK (bill_lang IS NULL OR bill_lang IN ('en','hi','ta','ml','kn','ar'));
