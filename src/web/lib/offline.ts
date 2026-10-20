/**
 * Offline support on the page side.
 * - Outbox: new records created without a connection are stored in IndexedDB on this device and sent when the
 *   connection returns. Each carries an Idempotency-Key, so a retry after an uncertain network failure never
 *   creates a duplicate (the server replays the first result).
 * - Cached reads are handled by the service worker (public/sw.js); this module warms and clears that cache.
 */
import { useEffect, useState } from "react";
import { api, ApiError, errorMessage, isNativeApp } from "./api";

export interface OutboxEntry {
  /** Also the Idempotency-Key of the create request. */
  id: string;
  userId: string;
  companyId: string;
  path: string;
  body: unknown;
  /** Follow-up action posted to `${path}/${createdId}${then}` once created (e.g. "/issue"). */
  then?: string;
  label: string;
  createdAt: number;
  status: "pending" | "failed";
  error?: string;
  createdId?: string;
}

export interface Queued { queued: true; id: string }
export const isQueued = (r: unknown): r is Queued => typeof r === "object" && r !== null && (r as Queued).queued === true;

const DB_NAME = "ledgerfox";
const STORE = "outbox";
const API_CACHE = "lf-api-v1";
const EVENT = "ledgerfox:outbox";

let currentUser: string | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const notify = () => window.dispatchEvent(new Event(EVENT));

export async function listOutbox(): Promise<OutboxEntry[]> {
  if (!currentUser) return [];
  const all = await store<OutboxEntry[]>("readonly", (s) => s.getAll() as IDBRequest<OutboxEntry[]>);
  return all.filter((e) => e.userId === currentUser).sort((a, b) => a.createdAt - b.createdAt);
}

async function putEntry(e: OutboxEntry) { await store("readwrite", (s) => s.put(e)); notify(); }
export async function removeOutboxEntry(id: string) { await store("readwrite", (s) => s.delete(id)); notify(); }
export async function retryOutboxEntry(e: OutboxEntry) { await putEntry({ ...e, status: "pending", error: undefined }); void flushOutbox(); }

/**
 * Create a record, or queue it on this device when there is no connection. Returns the server response, or
 * `{ queued: true }` when stored for later. Server-side validation errors are thrown as usual when online.
 */
/** crypto.randomUUID needs a secure context; phones on the office Wi-Fi reach the desktop app over plain http. */
export function randomKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function postOrQueue<T = any>(path: string, body: unknown, opts: { label: string; then?: string }): Promise<T | Queued> {
  const id = randomKey();
  if (navigator.onLine) {
    try {
      return await api.post<T>(path, body, { "idempotency-key": id });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 0)) throw e;
    }
  }
  if (!currentUser) throw new ApiError(0, "NETWORK", "Network error — check your connection and try again.");
  const companyId = /^\/api\/c\/([^/]+)\//.exec(path)?.[1] ?? "";
  await putEntry({ id, userId: currentUser, companyId, path, body, then: opts.then, label: opts.label, createdAt: Date.now(), status: "pending" });
  return { queued: true, id };
}

let flushing: Promise<void> | null = null;
/** Send pending entries in the order they were made. Stops at the first connectivity problem and retries later. */
export function flushOutbox(): Promise<void> {
  flushing ??= doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  if (!navigator.onLine || !currentUser) return;
  let entries: OutboxEntry[];
  try { entries = (await listOutbox()).filter((e) => e.status === "pending"); } catch { return; }
  for (const entry of entries) {
    const e = { ...entry };
    try {
      if (!e.createdId) {
        const r = await api.post<{ id?: string }>(e.path, e.body, { "idempotency-key": e.id });
        e.createdId = r?.id ?? "";
        if (e.then) await putEntry(e);
      }
      if (e.then && e.createdId) await api.post(`${e.path}/${e.createdId}${e.then}`, {}, { "idempotency-key": `${e.id}.then` });
      await removeOutboxEntry(e.id);
      window.dispatchEvent(new CustomEvent("ledgerfox:synced", { detail: e }));
    } catch (err) {
      const transient = err instanceof ApiError && (err.status === 0 || err.status === 401 || err.status === 429 || err.status >= 500 || err.code === "IN_PROGRESS");
      if (transient) break;
      await putEntry({ ...e, status: "failed", error: (e.createdId ? "Saved as a draft, but the follow-up step failed: " : "") + errorMessage(err) });
    }
  }
}

/** Called when the signed-in user changes; only that user's queued entries are ever sent. */
export function setOfflineUser(userId: string | null) {
  if (userId) {
    // A different person signing in on this device must never see the previous user's cached pages.
    let last: string | null = null;
    try { last = localStorage.getItem("ledgerfox-last-user"); localStorage.setItem("ledgerfox-last-user", userId); } catch { /* storage unavailable */ }
    if (last && last !== userId) void caches?.delete(API_CACHE).catch(() => undefined);
  }
  currentUser = userId;
  notify();
  if (userId) void flushOutbox();
}

/** Remove everything this device holds for the signed-in user: cached pages and unsent entries. */
export async function clearOfflineData() {
  try { await caches.delete(API_CACHE); } catch { /* Cache API unavailable */ }
  try { for (const e of await listOutbox()) await store("readwrite", (s) => s.delete(e.id)); } catch { /* IndexedDB unavailable */ }
  notify();
}

/** Fetch the lists the entry forms need so they work offline later (the service worker stores the responses). */
const warmed = new Map<string, number>();
export function warmOfflineCache(companyId: string) {
  if (!navigator.onLine || !navigator.serviceWorker?.controller) return;
  const last = warmed.get(companyId) ?? 0;
  if (Date.now() - last < 10 * 60_000) return;
  warmed.set(companyId, Date.now());
  const base = `/api/c/${companyId}`;
  for (const p of ["/settings", "/accounts", "/contacts?kind=customer&active=1&limit=500", "/contacts?kind=supplier&active=1&limit=500", "/items?active=1&limit=500", "/reports/dashboard"]) {
    void fetch(base + p, { credentials: "same-origin" }).catch(() => undefined);
  }
}

export function startOfflineSync() {
  window.addEventListener("online", () => void flushOutbox());
  setInterval(() => void flushOutbox(), 60_000);
  if ("serviceWorker" in navigator && import.meta.env.PROD && !isNativeApp()) {
    navigator.serviceWorker.register(`/sw.js?v=${__BUILD_ID__}`).catch(() => undefined);
  }
}

export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

export function useOutbox(companyId?: string) {
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => listOutbox().then((all) => { if (live) setEntries(companyId ? all.filter((e) => e.companyId === companyId) : all); }).catch(() => undefined);
    load();
    window.addEventListener(EVENT, load);
    return () => { live = false; window.removeEventListener(EVENT, load); };
  }, [companyId]);
  return entries;
}
