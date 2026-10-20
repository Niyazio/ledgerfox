/**
 * Depreciation methods (monthly):
 *  - SLM: depreciable base = cost − salvage spread evenly over useful life. Uses cumulative targets
 *    round(base × k / life) so the schedule never drifts from the exact total.
 *  - WDV: monthly charge = round(opening WDV × annual rate / 12), never taking WDV below salvage.
 *    (A monthly approximation of the annual written-down-value method.)
 */
import { divRound } from "@shared/money";

export interface AssetLike {
  cost: number;
  salvage_value: number;
  method: "slm" | "wdv";
  useful_life_months: number | null;
  wdv_rate_bp: number | null;
  depreciation_start_date: string;
}

export function monthIndex(startDate: string, month: string): number {
  const [sy, sm] = startDate.slice(0, 7).split("-").map(Number);
  const [y, m] = month.split("-").map(Number);
  return (y - sy) * 12 + (m - sm) + 1; // 1-based: start month = 1
}

/** Depreciation for a given month, given the accumulated depreciation before that month. */
export function depreciationFor(asset: AssetLike, month: string, accumulatedBefore: number): number {
  const k = monthIndex(asset.depreciation_start_date, month);
  if (k < 1) return 0;
  const base = asset.cost - asset.salvage_value;
  const remaining = base - accumulatedBefore;
  if (remaining <= 0) return 0;
  if (asset.method === "slm") {
    const life = asset.useful_life_months!;
    if (k > life) return remaining > 0 ? remaining : 0; // catch any residue in the month after life ends
    const target = Number(divRound(BigInt(base) * BigInt(k), BigInt(life)));
    return Math.max(0, Math.min(remaining, target - accumulatedBefore));
  }
  const wdv = asset.cost - accumulatedBefore;
  const charge = Number(divRound(BigInt(wdv) * BigInt(asset.wdv_rate_bp!), 120000n));
  return Math.max(0, Math.min(remaining, charge));
}

export function schedule(asset: AssetLike, months = 600) {
  const out: { month: string; amount: number; accumulated: number; book_value: number }[] = [];
  let acc = 0;
  const [sy, sm] = asset.depreciation_start_date.slice(0, 7).split("-").map(Number);
  for (let i = 0; i < months; i++) {
    const y = sy + Math.floor((sm - 1 + i) / 12);
    const m = ((sm - 1 + i) % 12) + 1;
    const month = `${y}-${String(m).padStart(2, "0")}`;
    const amt = depreciationFor(asset, month, acc);
    if (amt <= 0 && i > 0) break;
    acc += amt;
    out.push({ month, amount: amt, accumulated: acc, book_value: asset.cost - acc });
    if (acc >= asset.cost - asset.salvage_value) break;
  }
  return out;
}
