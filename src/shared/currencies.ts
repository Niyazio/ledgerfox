/** ISO 4217 currencies with their minor-unit exponent. */
export const CURRENCIES: Record<string, { name: string; exponent: number; symbol: string }> = {
  INR: { name: "Indian Rupee", exponent: 2, symbol: "₹" },
  USD: { name: "US Dollar", exponent: 2, symbol: "$" },
  EUR: { name: "Euro", exponent: 2, symbol: "€" },
  GBP: { name: "Pound Sterling", exponent: 2, symbol: "£" },
  AED: { name: "UAE Dirham", exponent: 2, symbol: "AED" },
  SAR: { name: "Saudi Riyal", exponent: 2, symbol: "SAR" },
  QAR: { name: "Qatari Riyal", exponent: 2, symbol: "QAR" },
  OMR: { name: "Omani Rial", exponent: 3, symbol: "OMR" },
  KWD: { name: "Kuwaiti Dinar", exponent: 3, symbol: "KWD" },
  BHD: { name: "Bahraini Dinar", exponent: 3, symbol: "BHD" },
  SGD: { name: "Singapore Dollar", exponent: 2, symbol: "S$" },
  AUD: { name: "Australian Dollar", exponent: 2, symbol: "A$" },
  CAD: { name: "Canadian Dollar", exponent: 2, symbol: "C$" },
  NZD: { name: "New Zealand Dollar", exponent: 2, symbol: "NZ$" },
  JPY: { name: "Japanese Yen", exponent: 0, symbol: "¥" },
  CNY: { name: "Chinese Yuan", exponent: 2, symbol: "CN¥" },
  CHF: { name: "Swiss Franc", exponent: 2, symbol: "CHF" },
  ZAR: { name: "South African Rand", exponent: 2, symbol: "R" },
  NPR: { name: "Nepalese Rupee", exponent: 2, symbol: "NPR" },
  LKR: { name: "Sri Lankan Rupee", exponent: 2, symbol: "LKR" },
  BDT: { name: "Bangladeshi Taka", exponent: 2, symbol: "৳" },
  MYR: { name: "Malaysian Ringgit", exponent: 2, symbol: "RM" },
  KES: { name: "Kenyan Shilling", exponent: 2, symbol: "KSh" },
};

export function currencyExponent(code: string): number {
  const c = CURRENCIES[code];
  if (!c) throw new RangeError(`Unsupported currency: ${code}`);
  return c.exponent;
}

export function isCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

/** Locale-aware money formatting from minor units (display only, never used for arithmetic). */
export function formatMoney(minor: number, currency: string, locale = "en-IN", withSymbol = true): string {
  const exp = CURRENCIES[currency]?.exponent ?? 2;
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const base = 10 ** exp;
  const whole = Math.trunc(abs / base);
  const frac = abs - whole * base;
  const wholeStr = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(whole);
  const decSep = new Intl.NumberFormat(locale).format(1.5).charAt(1) || ".";
  const body = exp > 0 ? `${wholeStr}${decSep}${String(frac).padStart(exp, "0")}` : wholeStr;
  const sym = withSymbol ? (CURRENCIES[currency]?.symbol ?? currency) : "";
  const spaced = sym && sym.length > 1 && /^[A-Z]/.test(sym) ? `${sym} ` : sym;
  return `${neg ? "-" : ""}${spaced}${body}`;
}
