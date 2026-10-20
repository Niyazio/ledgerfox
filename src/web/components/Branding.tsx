import { useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { imageToDataUrl } from "../lib/image";

export interface BrandingValue { logo?: string | null; payment_qr?: string | null }

function ImagePick({ label, hint, value, max, onChange }: { label: string; hint: string; value: string | null | undefined; max: number; onChange: (v: string | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex items-center gap-3">
        <label className="flex h-24 w-24 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-2)] hover:border-brand-500">
          {value ? <img src={value} alt={label} className="max-h-full max-w-full object-contain" /> : <ImagePlus className="h-6 w-6 muted" />}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label={label}
            onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; setError(null); try { onChange(await imageToDataUrl(f, max)); } catch (err) { setError((err as Error).message); } }} />
        </label>
        <div className="text-xs muted">
          <p>{hint}</p>
          {value && <button type="button" className="mt-1 inline-flex items-center gap-1 text-red-600 hover:underline" onClick={() => onChange(null)}><X className="h-3.5 w-3.5" />Remove</button>}
          {error && <p className="mt-1 text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  );
}

/** Company logo and the business's own payment QR (e.g. from the bank or UPI app). Both appear on printed documents. */
export function BrandingFields({ value, onChange }: { value: BrandingValue; onChange: (v: BrandingValue) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ImagePick label="Company logo" hint="Shown on invoices, bills, receipts and payslips. PNG with transparent background works best." value={value.logo} max={480} onChange={(logo) => onChange({ ...value, logo })} />
      <ImagePick label="Payment QR code" hint="Your business UPI / bank QR image. Printed on invoices as “Scan to pay”. Without it, a UPI QR is generated from your UPI ID." value={value.payment_qr} max={640} onChange={(payment_qr) => onChange({ ...value, payment_qr })} />
    </div>
  );
}
