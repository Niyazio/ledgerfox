/** The company last opened on this device: a product QR scanned with the phone camera bills in it. */
const LAST = "ledgerfox-last-company";
export const rememberCompany = (id: string) => { try { localStorage.setItem(LAST, id); } catch { /* storage unavailable */ } };
export const lastCompany = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
