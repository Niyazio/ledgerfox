/**
 * Free ways to send a document: a WhatsApp chat link (wa.me), an email draft (mailto:), or the device share sheet.
 * Nothing is sent by LedgerFox itself, so there is no SMS/WhatsApp API cost; the user presses Send in their own app.
 */

/** UPI deep link (opens any UPI app on a phone) for a payment of `amountMinor` paise. */
export function upiLink(upiId: string, payee: string, amountMinor: number, note: string): string {
  const q = new URLSearchParams({ pa: upiId, pn: payee, am: (amountMinor / 100).toFixed(2), cu: "INR", tn: note.slice(0, 80) });
  return `upi://pay?${q.toString().replace(/\+/g, "%20")}`;
}

/** Phone number → wa.me digits. Ten-digit Indian mobile numbers get the 91 country code. */
export function waNumber(phone: string | null | undefined, defaultCountry = "91"): string | null {
  const d = (phone ?? "").replace(/[^\d]/g, "").replace(/^0+/, "");
  if (d.length === 10) return `${defaultCountry}${d}`;
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

/** WhatsApp link: to a number when known, otherwise WhatsApp asks whom to send it to. */
export const whatsappUrl = (text: string, phone?: string | null) => `https://wa.me/${waNumber(phone) ?? ""}?text=${encodeURIComponent(text)}`;

export const mailtoUrl = (to: string | null | undefined, subject: string, body: string) =>
  `mailto:${encodeURIComponent(to ?? "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

export interface ShareDoc {
  kind: "invoice" | "quote" | "sales_order" | "credit_note" | "receipt" | "statement";
  number: string; party: string; company: string; date: string; dueDate?: string | null;
  total: string; balance?: string | null; overdueDays?: number; link?: string | null; upiId?: string | null;
}

/** Message text for sending or reminding; plain text so it reads well in WhatsApp, SMS and email. */
export function shareMessage(d: ShareDoc, reminder = false): string {
  const name = { invoice: "Invoice", quote: "Quotation", sales_order: "Sales order", credit_note: "Credit note", receipt: "Payment receipt", statement: "Statement" }[d.kind];
  const lines = [`Dear ${d.party},`, ""];
  if (d.kind === "statement") lines.push(`Your account statement for ${d.date}: closing balance ${d.total}${d.balance ? ` (${d.balance})` : ""}.`, "Please let us know if anything does not match your records.");
  else if (d.kind === "receipt") lines.push(`Thank you. We have received ${d.total} (receipt ${d.number}, ${d.date}).`);
  else if (reminder) lines.push(`This is a friendly reminder that ${name.toLowerCase()} ${d.number} dated ${d.date} has ${d.balance} outstanding${d.dueDate ? `, due on ${d.dueDate}` : ""}${d.overdueDays ? ` (${d.overdueDays} days overdue)` : ""}.`);
  else {
    lines.push(`Please find ${name.toLowerCase()} ${d.number} dated ${d.date} for ${d.total}.`);
    if (d.balance && d.kind === "invoice") lines.push(`Amount due: ${d.balance}${d.dueDate ? ` by ${d.dueDate}` : ""}.`);
  }
  if (d.link) lines.push("", `View${d.kind === "invoice" && d.balance ? " and pay" : ""} online: ${d.link}`);
  if (d.upiId && d.balance && d.kind === "invoice") lines.push(`UPI: ${d.upiId}`);
  lines.push("", `Regards,`, d.company);
  return lines.join("\n");
}
