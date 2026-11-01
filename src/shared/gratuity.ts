/**
 * End-of-service gratuity for private-sector employees, from the basic monthly wage and the length of service.
 * - UAE (Federal Decree-Law 33 of 2021, art. 51): after at least one year, 21 days' basic wage for each of the first five
 *   years and 30 days' for each year after, pro rata for part years; capped at two years' wage. Resigning does not
 *   reduce it under the 2021 law.
 * - Saudi Arabia (Labour Law art. 84–85): half a month's wage for each of the first five years and a month's for each
 *   year after, pro rata. On resignation: nothing under 2 years, a third for 2–5 years, two thirds for 5–10 years,
 *   all of it from 10 years.
 * A day's wage is the monthly wage ÷ 30. Saudi law uses the last full wage (basic plus regular allowances): pass that
 * as the wage when it differs from the basic. Estimates for planning — confirm final settlements with the labour rules
 * in force and the employment contract.
 */
export type GratuityCountry = "AE" | "SA";
export type LeavingReason = "termination" | "resignation";

export interface GratuityResult { years: number; amount: number; note: string }

const DAY = 86_400_000;

/** Service in years (with fractions) between two ISO dates. */
export function serviceYears(joined: string, until: string): number {
  return Math.max(0, (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${joined}T00:00:00Z`)) / DAY / 365);
}

/** Gratuity in minor units for a monthly wage (minor units). */
export function gratuity(country: GratuityCountry, monthlyWage: number, joined: string, until: string, reason: LeavingReason = "termination"): GratuityResult {
  const years = serviceYears(joined, until);
  const day = monthlyWage / 30;
  if (country === "AE") {
    if (years < 1) return { years, amount: 0, note: "Less than one year of service: no gratuity." };
    const amount = day * 21 * Math.min(years, 5) + day * 30 * Math.max(0, years - 5);
    const cap = monthlyWage * 24;
    return { years, amount: Math.round(Math.min(amount, cap)), note: amount > cap ? "Capped at two years' wage." : "21 days per year for the first 5 years, 30 days after." };
  }
  const full = (monthlyWage / 2) * Math.min(years, 5) + monthlyWage * Math.max(0, years - 5);
  if (reason === "termination") return { years, amount: Math.round(full), note: "Half a month per year for the first 5 years, a month per year after." };
  const share = years < 2 ? 0 : years < 5 ? 1 / 3 : years < 10 ? 2 / 3 : 1;
  return { years, amount: Math.round(full * share), note: years < 2 ? "Resigned with less than 2 years: no award." : `Resignation: ${share === 1 ? "full" : share > 0.5 ? "two thirds of the" : "a third of the"} award.` };
}
