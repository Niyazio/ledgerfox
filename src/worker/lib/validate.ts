import { z } from "zod";
import type { Context } from "hono";
import { badRequest } from "./errors";
import { parseDecimal, parseQty, parseRate, parsePercentToBp } from "@shared/money";

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Invalid date");

export const idStr = z.string().min(1).max(64);
export const optId = z.string().min(1).max(64).nullish();
export const shortText = (max = 200) => z.string().trim().max(max);
export const reqText = (max = 200) => z.string().trim().min(1, "Required").max(max);
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code");

/** Decimal amount accepted as string or number; converted to minor units later with the right exponent. */
export const decimalStr = z.union([z.string(), z.number()]).transform((v) => String(v));

export function minor(value: string | number, exponent: number, field = "amount"): number {
  try {
    return parseDecimal(value, exponent);
  } catch (e) {
    throw badRequest(`${field}: ${(e as Error).message}`);
  }
}

export function qty(value: string | number, field = "quantity"): number {
  try {
    return parseQty(value);
  } catch (e) {
    throw badRequest(`${field}: ${(e as Error).message}`);
  }
}

export function rate(value: string | number | null | undefined, field = "exchange rate"): number {
  if (value === null || value === undefined || value === "") return 1_000_000_000;
  try {
    return parseRate(value);
  } catch (e) {
    throw badRequest(`${field}: ${(e as Error).message}`);
  }
}

export function percentBp(value: string | number | null | undefined, field = "percentage"): number {
  if (value === null || value === undefined || value === "") return 0;
  try {
    return parsePercentToBp(value);
  } catch (e) {
    throw badRequest(`${field}: ${(e as Error).message}`);
  }
}

export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw badRequest("Validation failed", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

export function pageParams(c: Context) {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 500);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  return { limit, offset };
}

export function dateParam(c: Context, name: string, fallback: string): string {
  const v = c.req.query(name);
  if (!v) return fallback;
  const r = isoDate.safeParse(v);
  if (!r.success) throw badRequest(`${name} must be YYYY-MM-DD`);
  return v;
}
