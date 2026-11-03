/**
 * Subscription plans for the hosted (cloud) edition. Prices are in paise, before GST. Limits are enforced on the
 * server only when billing is switched on (BILLING_ENABLED); the desktop edition is never limited.
 */
export type PlanId = "free" | "starter" | "business" | "multi_branch";
export type Interval = "monthly" | "yearly";
export type Feature = "pos" | "payroll" | "recurring" | "gst_returns";

export interface Plan {
  id: PlanId; name: string; tagline: string;
  price: Record<Interval, number>;
  limits: { users: number; branches: number; companies: number };
  features: Feature[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "Free", tagline: "One person, one shop", price: { monthly: 0, yearly: 0 }, limits: { users: 1, branches: 1, companies: 1 }, features: [] },
  starter: { id: "starter", name: "Starter", tagline: "Small shop with a few staff", price: { monthly: 29_900, yearly: 2_99_900 }, limits: { users: 3, branches: 1, companies: 1 }, features: ["gst_returns", "recurring"] },
  business: { id: "business", name: "Business", tagline: "Counter billing, payroll and inventory", price: { monthly: 79_900, yearly: 7_99_900 }, limits: { users: 10, branches: 2, companies: 2 }, features: ["gst_returns", "recurring", "pos", "payroll"] },
  multi_branch: { id: "multi_branch", name: "Multi-branch", tagline: "Up to 5 branches with branch managers", price: { monthly: 1_99_900, yearly: 19_99_900 }, limits: { users: 25, branches: 5, companies: 3 }, features: ["gst_returns", "recurring", "pos", "payroll"] },
};
export const PAID_PLANS: PlanId[] = ["starter", "business", "multi_branch"];

/**
 * Subscription currency. Customers in India pay in rupees (UPI, cards, net banking, mandates); elsewhere by card in
 * their region's currency: UAE in dirhams, Saudi Arabia in riyals, every other country in US dollars. Razorpay takes
 * the international cards once "International payments" is activated on the account.
 */
export type BillingCurrency = "INR" | "USD" | "AED" | "SAR";
export const BILLING_CURRENCIES: BillingCurrency[] = ["INR", "USD", "AED", "SAR"];
export const billingCurrencyFor = (country: string | null | undefined): BillingCurrency =>
  country === "IN" ? "INR" : country === "AE" ? "AED" : country === "SA" ? "SAR" : "USD";

/** Prices in minor units (paise, cents, fils, halalas); yearly is 10 × monthly (two months free). Edit freely. */
const INTL: Record<Exclude<BillingCurrency, "INR">, Record<Exclude<PlanId, "free">, number>> = {
  USD: { starter: 5_00, business: 12_00, multi_branch: 29_00 },
  AED: { starter: 19_00, business: 45_00, multi_branch: 109_00 },
  SAR: { starter: 19_00, business: 45_00, multi_branch: 109_00 },
};
export function planPrice(plan: PlanId, interval: Interval, currency: BillingCurrency): number {
  if (plan === "free") return 0;
  if (currency === "INR") return PLANS[plan].price[interval];
  return INTL[currency][plan] * (interval === "yearly" ? 10 : 1);
}
/** The plans with prices in one currency (what the Plan & billing page shows). */
export const plansIn = (currency: BillingCurrency): Plan[] =>
  Object.values(PLANS).map((p) => ({ ...p, price: { monthly: planPrice(p.id, "monthly", currency), yearly: planPrice(p.id, "yearly", currency) } }));
export const TRIAL_PLAN: PlanId = "business";
export const TRIAL_DAYS = 30;
export const GRACE_DAYS = 7;

export const FEATURE_LABELS: Record<Feature, string> = {
  pos: "POS counter billing", payroll: "Payroll", recurring: "Recurring invoices", gst_returns: "GST / VAT returns",
};

/** GST on the subscription price (minor units), rounded to a whole unit like most invoices. Pass 0 for exports. */
export function withGst(amount: number, gstPercent: number) {
  const gst = Math.round((amount * gstPercent) / 100 / 100) * 100;
  return { amount, gst, total: amount + gst };
}

/**
 * Education mode (practice companies) is given by LedgerFox to the emails it approves — a teacher, an institute or a
 * trainer. It is free for up to EDUCATION_FREE_DEVICES devices; a class that needs more buys a student pack, which
 * runs for 6 months. Prices are in minor units before tax. Edit freely.
 */
export type EducationPackId = "edu25" | "edu50" | "edu100";
export const EDUCATION_FREE_DEVICES = 10;
export const EDUCATION_PACK_MONTHS = 6;
export interface EducationPack { id: EducationPackId; students: number; price: Record<BillingCurrency, number> }
export const EDUCATION_PACKS: Record<EducationPackId, EducationPack> = {
  edu25: { id: "edu25", students: 25, price: { INR: 2_999_00, USD: 39_00, AED: 149_00, SAR: 149_00 } },
  edu50: { id: "edu50", students: 50, price: { INR: 4_999_00, USD: 59_00, AED: 219_00, SAR: 219_00 } },
  edu100: { id: "edu100", students: 100, price: { INR: 7_999_00, USD: 99_00, AED: 369_00, SAR: 369_00 } },
};
export const EDUCATION_PACK_IDS = Object.keys(EDUCATION_PACKS) as EducationPackId[];
