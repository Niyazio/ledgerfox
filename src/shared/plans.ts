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
export const TRIAL_PLAN: PlanId = "business";
export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;

export const FEATURE_LABELS: Record<Feature, string> = {
  pos: "POS counter billing", payroll: "Payroll", recurring: "Recurring invoices", gst_returns: "GSTR-1 / GSTR-3B",
};

/** GST on the subscription price (paise), rounded to the rupee like most invoices. */
export function withGst(amount: number, gstPercent: number) {
  const gst = Math.round((amount * gstPercent) / 100 / 100) * 100;
  return { amount, gst, total: amount + gst };
}
