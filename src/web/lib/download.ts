import { isNativeApp } from "./api";

interface FilesystemPlugin { writeFile(o: { path: string; data: string; directory: string }): Promise<{ uri: string }> }
interface SharePlugin { share(o: { title?: string; text?: string; files?: string[]; dialogTitle?: string }): Promise<unknown> }

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

/**
 * Send a file (e.g. an invoice PDF) to another app: the Android app and phones/tablets open the system share sheet
 * with the file attached (WhatsApp, Gmail, Drive…); browsers that cannot share files download it instead.
 * Returns what happened so the caller can explain the next step.
 */
export async function shareFile(blob: Blob, filename: string, info: { title: string; text?: string }): Promise<"shared" | "saved" | "cancelled"> {
  const name = filename.replace(/[^\w.-]+/g, "_");
  const p = plugins();
  if (isNativeApp() && p?.Filesystem && p.Share) {
    const { uri } = await p.Filesystem.writeFile({ path: name, data: await base64(blob), directory: "CACHE" });
    await p.Share.share({ title: info.title, text: info.text, files: [uri], dialogTitle: "Send the PDF" });
    return "shared";
  }
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: info.title, text: info.text });
      return "shared";
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return "cancelled";
      // NotAllowedError: the tap was too long ago (the PDF took a while); the caller asks for one more tap.
      if ((e as DOMException)?.name === "NotAllowedError") throw e;
    }
  }
  await saveFile(blob, name);
  return "saved";
}

/** Print the page. The Android app's web view cannot print, so it says what to do instead. */
export function printPage() {
  if (isNativeApp()) {
    alert("Printing is not available inside the Android app. Use “Share PDF” to send the bill as a PDF, or open the PDF in a printing app.");
    return;
  }
  window.print();
}
