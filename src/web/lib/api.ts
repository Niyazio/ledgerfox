export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

/** In the Android app's offline copy, requests are answered by the on-phone engine instead of the network. */
let transport: ((path: string, init: RequestInit) => Promise<Response>) | null = null;
export function setTransport(t: typeof transport) { transport = t; }
export const isOfflineCopy = () => transport !== null;

/** True inside the Android app (Capacitor WebView). */
export const isNativeApp = () => Boolean((globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());

async function request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { "x-requested-with": "ledgerfox", ...extraHeaders };
  let payload: BodyInit | undefined;
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    payload = body as BodyInit;
    if (body instanceof Blob && body.type) headers["content-type"] = body.type;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = transport ? await transport(path, { method, headers, body: payload }) : await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "NETWORK", "Network error — check your connection and try again.");
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = json?.error;
    if (res.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event("ledgerfox:unauthorized"));
    throw new ApiError(res.status, e?.code ?? "HTTP_ERROR", e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return json as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>("GET", p),
  post: <T = any>(p: string, b?: unknown, headers?: Record<string, string>) => request<T>("POST", p, b ?? {}, headers),
  put: <T = any>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  patch: <T = any>(p: string, b?: unknown) => request<T>("PATCH", p, b ?? {}),
  del: <T = any>(p: string) => request<T>("DELETE", p),
  upload: <T = any>(p: string, file: File) => request<T>("POST", p, file),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (Array.isArray(e.details) && e.details.length && (e.details[0] as any)?.message) {
      return `${e.message}: ${(e.details as any[]).slice(0, 3).map((d) => `${d.path ? d.path + " — " : ""}${d.message ?? d.error}`).join("; ")}`;
    }
    return e.message;
  }
  return e instanceof Error ? e.message : "Unexpected error";
}
