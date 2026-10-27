import { isNativeApp } from "./api";

interface FilesystemPlugin { writeFile(o: { path: string; data: string; directory: string }): Promise<{ uri: string }> }
interface SharePlugin { share(o: { title?: string; files?: string[]; dialogTitle?: string }): Promise<unknown> }

const plugins = () => (globalThis as { Capacitor?: { Plugins?: { Filesystem?: FilesystemPlugin; Share?: SharePlugin } } }).Capacitor?.Plugins;

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Save a file made in the page (Excel, CSV, JSON…). Browsers download it; the Android app, whose web view ignores
 * such downloads, writes it to the app's storage and opens the share sheet (Downloads, Drive, WhatsApp, email…).
 */
export async function saveFile(blob: Blob, filename: string) {
  const name = filename.replace(/[^\w.-]+/g, "_");
  const p = plugins();
  if (isNativeApp() && p?.Filesystem && p.Share) {
    const { uri } = await p.Filesystem.writeFile({ path: name, data: await base64(blob), directory: "CACHE" });
    await p.Share.share({ title: name, files: [uri], dialogTitle: "Save or send the file" });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Print the page. The Android app's web view cannot print, so it says what to do instead. */
export function printPage() {
  if (isNativeApp()) {
    alert("Printing is not available inside the Android app yet. Use Share (WhatsApp or email) to send the bill, download it as Excel, or print from the computer.");
    return;
  }
  window.print();
}
