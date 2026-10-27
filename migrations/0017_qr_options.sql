-- Which QR codes print on bills by default (each can still be switched for one print). Additive only.
ALTER TABLE companies ADD COLUMN print_qr_verify INTEGER NOT NULL DEFAULT 1 CHECK (print_qr_verify IN (0,1));
ALTER TABLE companies ADD COLUMN print_qr_upi INTEGER NOT NULL DEFAULT 1 CHECK (print_qr_upi IN (0,1));
