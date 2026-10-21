const enc = new TextEncoder();

export function newId(): string {
  return crypto.randomUUID();
}

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return base64url(b);
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? enc.encode(input) : input;
  return hex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

/** Workers caps PBKDF2 at 100,000 iterations. */
export const MAX_PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string, iterations: number, saltB64?: string) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: Math.min(iterations, MAX_PBKDF2_ITERATIONS) },
    key,
    256,
  );
  return {
    hash: hex(bits),
    salt: btoa(String.fromCharCode(...salt)),
    iterations: Math.min(iterations, MAX_PBKDF2_ITERATIONS),
  };
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, stored: { password_hash: string; password_salt: string; password_iters: number }) {
  const { hash } = await hashPassword(password, stored.password_iters, stored.password_salt);
  return timingSafeEqual(hash, stored.password_hash);
}

/** Human-friendly one-time recovery code, e.g. "K7QF-9XWD-M2PA". */
export function recoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...b].map((x) => alphabet[x % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/** Random one-time password for a new or reset staff account, e.g. "k7QfR-9XwDm-2PaH8" (15 of 54 characters ≈ 86 bits; no look-alike characters). */
export function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const limit = 256 - (256 % alphabet.length); // reject the top bytes so every character is equally likely
  const out: string[] = [];
  while (out.length < 15) {
    for (const x of crypto.getRandomValues(new Uint8Array(32))) {
      if (x < limit && out.length < 15) out.push(alphabet[x % alphabet.length]);
    }
  }
  const s = out.join("");
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10)}`;
}
