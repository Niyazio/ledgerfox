/** Amount in words, Indian numbering (lakh / crore) for INR and international (million / billion) otherwise. */
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? " " + ONES[r % 10] : ""}`;
  return [h ? `${ONES[h]} Hundred` : "", rest].filter(Boolean).join(" ");
}

function integerWords(n: number, indian: boolean): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const scales: [number, string][] = indian
    ? [[10_000_000, "Crore"], [100_000, "Lakh"], [1000, "Thousand"]]
    : [[1_000_000_000, "Billion"], [1_000_000, "Million"], [1000, "Thousand"]];
  let rest = n;
  for (const [size, name] of scales) {
    if (rest >= size) {
      const q = Math.floor(rest / size);
      parts.push(`${q >= 1000 ? integerWords(q, indian) : below1000(q)} ${name}`);
      rest %= size;
    }
  }
  if (rest) parts.push(below1000(rest));
  return parts.join(" ");
}

const NAMES: Record<string, [string, string]> = {
  INR: ["Rupees", "Paise"], USD: ["Dollars", "Cents"], EUR: ["Euros", "Cents"], GBP: ["Pounds", "Pence"], AED: ["Dirhams", "Fils"],
  SAR: ["Riyals", "Halalas"], SGD: ["Dollars", "Cents"], AUD: ["Dollars", "Cents"], CAD: ["Dollars", "Cents"],
};

export function amountInWords(minor: number, currency: string, exponent = 2): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const div = 10 ** exponent;
  const major = Math.floor(abs / div);
  const fraction = abs % div;
  const [unit, sub] = NAMES[currency] ?? [currency, "Cents"];
  const indian = currency === "INR";
  let s = `${unit} ${integerWords(major, indian)}`;
  if (fraction && exponent > 0) s += ` and ${integerWords(fraction, indian)} ${sub}`;
  return `${negative ? "Minus " : ""}${s} Only`;
}
