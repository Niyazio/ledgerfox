import { useState } from "react";
import { Copy, Mail, MessageCircle, Send, Share2 } from "lucide-react";
import { useCompany } from "../lib/company";
import { useSession } from "../lib/session";
import { api, errorMessage } from "../lib/api";
import { mailtoUrl, shareMessage, whatsappUrl, type ShareDoc } from "@shared/share";
import { Button, Modal, Textarea, useToast } from "./ui";

/**
 * Send a document to the customer from your own WhatsApp or email. On the cloud edition the message includes a
 * private link where the customer can view, print and pay; the desktop edition has no public address, so it sends text only.
 */
export function ShareButton({ entity, doc, phone, email, reminder = false, label }: {
  entity: { type: "document" | "payment"; id: string };
  doc: Omit<ShareDoc, "link" | "company" | "upiId">;
  phone?: string | null; email?: string | null; reminder?: boolean; label?: string;
}) {
  const { path, settings } = useCompany();
  const { me } = useSession();
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      let link: string | null = null;
      if (me?.edition === "cloud") {
        const r = await api.post<{ token: string }>(path("/verify"), { entity_type: entity.type, entity_id: entity.id });
        link = `${location.origin}/verify/${r.token}`;
      }
      const co = settings!.company;
      setText(shareMessage({ ...doc, link, company: co.legal_name || co.name, upiId: co.upi_id ?? null }, reminder));
    } catch (e) { toast("error", errorMessage(e)); } finally { setBusy(false); }
  };
  const subject = `${reminder ? "Payment reminder: " : ""}${doc.kind === "receipt" ? "Receipt" : doc.kind === "quote" ? "Quotation" : doc.kind === "credit_note" ? "Credit note" : "Invoice"} ${doc.number} from ${settings?.company.name ?? ""}`;
  return (
    <>
      <Button variant="secondary" loading={busy} onClick={() => void open()}>{reminder ? <Send className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}{label ?? (reminder ? "Send reminder" : "Share")}</Button>
      {text !== null && (
        <Modal open title={reminder ? "Send payment reminder" : `Share ${doc.number}`} onClose={() => setText(null)}>
          <p className="mb-2 text-sm muted">Edit the message if you like, then choose how to send it. It opens in your own WhatsApp or email app; nothing is sent until you press Send there.</p>
          <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" />
          <div className="mt-3 flex flex-wrap gap-2">
            <a className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700" href={whatsappUrl(text, phone)} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4" />WhatsApp{phone ? "" : " (choose chat)"}</a>
            <a className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium hover:bg-[var(--surface-2)]" href={mailtoUrl(email, subject, text)}><Mail className="h-4 w-4" />Email{email ? "" : " (enter address)"}</a>
            <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(text); toast("success", "Copied — paste it into SMS or any app"); }}><Copy className="h-4 w-4" />Copy</Button>
            {"share" in navigator && <Button variant="secondary" onClick={() => void navigator.share({ title: subject, text }).catch(() => undefined)}><Share2 className="h-4 w-4" />More apps</Button>}
          </div>
          {me?.edition !== "cloud" && <p className="mt-3 text-xs muted">The desktop edition is not on the internet, so the message has no online link. Attach the PDF from Print preview (Save as PDF) if needed.</p>}
        </Modal>
      )}
    </>
  );
}
