export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, "BAD_REQUEST", msg, details);
export const unauthorized = (msg = "Authentication required") => new AppError(401, "UNAUTHENTICATED", msg);
export const forbidden = (msg = "You do not have permission to perform this action") => new AppError(403, "FORBIDDEN", msg);
export const notFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
export const unprocessable = (code: string, msg: string, details?: unknown) => new AppError(422, code, msg, details);

/** Codes raised by database triggers (see migrations). */
const DB_CODES: Record<string, number> = {
  UNBALANCED: 422,
  TOO_FEW_LINES: 422,
  PERIOD_CLOSED: 422,
  INVALID_ACCOUNT: 422,
  TOTAL_MISMATCH: 422,
  ALREADY_POSTED: 409,
  POSTED_IMMUTABLE: 409,
  NOT_DEMO: 409,
  TENANT_MISMATCH: 403,
  PERIOD_IMMUTABLE: 409,
  AUDIT_IMMUTABLE: 409,
  STOCK_IMMUTABLE: 409,
  ALLOCATION_IMMUTABLE: 409,
  ALLOCATION_INVALID: 422,
  OVER_ALLOCATED: 422,
  SETTLED: 409,
  RECONCILED: 409,
  INSUFFICIENT_STOCK: 422,
};

/** Translate D1/SQLite errors (trigger RAISE, constraint failures) into AppErrors. */
export function fromDbError(err: unknown): AppError | null {
  const msg = err instanceof Error ? err.message : String(err);
  for (const m of msg.matchAll(/\b([A-Z][A-Z_]{3,}): ([^:]+?)(?=:\s*SQLITE_|:\s*[A-Z_]{4,}:|$)/g)) {
    if (DB_CODES[m[1]] !== undefined) return new AppError(DB_CODES[m[1]], m[1], m[2].trim());
  }
  if (/UNIQUE constraint failed/i.test(msg)) {
    if (/idempotency_key|source_type|source_id/.test(msg)) {
      return new AppError(409, "DUPLICATE_POSTING", "This transaction has already been posted");
    }
    if (/reversal_of_id/.test(msg)) return new AppError(409, "ALREADY_REVERSED", "This entry has already been reversed");
    if (/dedupe_hash/.test(msg)) return new AppError(409, "DUPLICATE", "Duplicate statement line");
    return new AppError(409, "DUPLICATE", "A record with the same unique value already exists");
  }
  if (/CHECK constraint failed/i.test(msg)) {
    if (/amount_settled/.test(msg)) return new AppError(422, "OVER_ALLOCATED", "Allocation exceeds the outstanding balance");
    return new AppError(422, "CONSTRAINT", "The data violates a validation rule");
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) {
    return new AppError(422, "INVALID_REFERENCE", "A referenced record does not exist in this company");
  }
  return null;
}
