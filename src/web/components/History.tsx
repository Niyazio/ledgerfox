import { useState } from "react";
import { History as HistoryIcon } from "lucide-react";
import { useCompany } from "../lib/company";
import { useApi } from "../lib/hooks";
import { Button, Modal, Spinner } from "./ui";
import { fmtDateTime } from "../lib/format";

const VERB: Record<string, string> = {
  create: "Created", create_post: "Created and posted", update: "Modified", issue: "Issued", post: "Posted", void: "Cancelled / voided",
  delete_draft: "Deleted draft", reverse: "Reversed", approved: "Approved", approval_requested: "Approval requested", approve_post: "Approved and posted",
  submit: "Submitted", reject: "Rejected", convert: "Converted", status: "Status changed", opening_balances: "Opening balances",
};

const label = (action: string) => VERB[action.slice(action.lastIndexOf(".") + 1)] ?? action;
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** "History" button that opens who-did-what-when for one record, with previous → new values where recorded. */
export function HistoryButton({ type, id }: { type: "document" | "payment" | "journal" | "expense" | "item" | "contact"; id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}><HistoryIcon className="h-4 w-4" />History</Button>
      {open && <HistoryModal type={type} id={id} onClose={() => setOpen(false)} />}
    </>
  );
}

function HistoryModal({ type, id, onClose }: { type: string; id: string; onClose: () => void }) {
  const { path } = useCompany();
  const { data, error } = useApi<{ events: { id: string; action: string; created_at: string; user_name: string | null; username: string | null; ip?: string; details: any }[] }>(path(`/daybook/history/${type}/${id}`));
  return (
    <Modal open title="History" onClose={onClose} wide>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!data ? <Spinner /> : !data.events.length ? <p className="text-sm muted">No recorded activity.</p> : (
        <ol className="relative space-y-4 border-l border-[var(--border)] pl-5">
          {data.events.map((e) => (
            <li key={e.id}>
              <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-[var(--surface)] bg-brand-600" />
              <p className="text-sm"><b>{label(e.action)}</b> by {e.user_name ?? "system"}{e.username ? <span className="muted"> ({e.username})</span> : null}</p>
              <p className="text-xs muted">{fmtDateTime(e.created_at)}{e.ip ? ` · ${e.ip}` : ""}</p>
              {e.details?.changes && Object.keys(e.details.changes).length > 0 && (
                <table className="mt-1 text-xs"><tbody>
                  {Object.entries(e.details.changes as Record<string, { from: unknown; to: unknown }>).map(([k, v]) => (
                    <tr key={k}><td className="pr-3 muted">{k.replace(/_/g, " ")}</td><td className="pr-2 line-through opacity-70">{show(v.from)}</td><td>→ {show(v.to)}</td></tr>
                  ))}
                </tbody></table>
              )}
              {e.details?.reason && <p className="mt-1 text-xs">Reason: {String(e.details.reason)}</p>}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
