/**
 * Saudi Arabia (ZATCA, phase 1): the QR code every simplified tax invoice must carry, and standard tax invoices may
 * carry. It is TLV — tag, length, UTF-8 value — for seller name (1), VAT number (2), invoice time (3), total with VAT
 * (4) and VAT total (5), then Base64. Phase 2 (signed XML reported to ZATCA's FATOORA platform) is not included.
 */
export interface ZatcaQrInput { seller: string; vatNumber: string; timestamp: string; total: string; vat: string }

export function zatcaQr(q: ZatcaQrInput): string {
  const enc = new TextEncoder();
  const parts: number[] = [];
  [q.seller, q.vatNumber, q.timestamp, q.total, q.vat].forEach((value, i) => {
    const bytes = enc.encode(value);
    if (bytes.length > 255) throw new Error(`ZATCA QR field ${i + 1} is too long`);
    parts.push(i + 1, bytes.length, ...bytes);
  });
  let bin = "";
  for (const b of parts) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Minor units to a plain decimal string ("1150.00"), as the QR expects. */
export const zatcaAmount = (minor: number, exponent = 2) => (minor / 10 ** exponent).toFixed(exponent);
