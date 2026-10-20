/** The phone's offline copy of a desktop data file, kept in IndexedDB. */
const DB = "ledgerfox-offline";
const STORE = "copies";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export interface OfflineCopy { bytes: Uint8Array; savedAt: string; source: string; companies: string[] }

export async function saveCopy(copy: OfflineCopy) {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(copy, "current");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadCopy(): Promise<OfflineCopy | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).get("current");
    r.onsuccess = () => resolve((r.result as OfflineCopy) ?? null);
    r.onerror = () => reject(r.error);
  });
}

export async function deleteCopy() {
  const db = await open();
  await new Promise<void>((resolve) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete("current"); tx.oncomplete = () => resolve(); });
}
