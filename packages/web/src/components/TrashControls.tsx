"use client";
// The platform-admin trash & delete controls (INNOBOX_SPEC.md §10.3, §10.4), shared by the
// challenge detail page and the /admin/trash page:
//   - DangerZone: on a live item — Move to trash (the primary action) and Delete permanently;
//   - TrashedBanner: on an item in the trash — when it will be purged, Restore and Delete permanently;
//   - DeletePermanentlyConfirm: the deliberate-friction dialog both use (type the number back AND
//     give a reason), because Delete permanently skips the trash and cannot be undone.
import { useState } from "react";
import { useDateFmt } from "@/components/DateFormat";
import { RESTORE_CHALLENGE_FIRST } from "@/lib/challenge-detail";

/** The §10.4 trash state as the detail payload carries it (platform admins only). */
export interface TrashInfo {
  at: string;
  by: string;
  reason: string;
  purgesOn: string;
}

const SECTION: React.CSSProperties = { marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" };
const REASON_MAX = 500;

/** The §10.3 confirm: arms only once the item's own number is typed back and a reason given. */
export function DeletePermanentlyConfirm({
  label,
  what,
  note,
  busy,
  onDelete,
  onCancel,
}: {
  label: string;
  what: string;
  note?: string;
  busy: boolean;
  onDelete: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const armed = typed.trim().toUpperCase() === label.toUpperCase() && reason.trim() !== "";
  return (
    <div role="dialog" aria-label={`Delete ${label} permanently`}>
      <p style={{ fontSize: 14, margin: "0 0 6px", fontWeight: 600 }}>Delete {label} permanently?</p>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
        This removes {what} permanently. It skips the trash and cannot be restored, and nobody is notified.
      </p>
      {note && (
        <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
          {note}
        </p>
      )}
      <label htmlFor={`del-confirm-${label}`} className="sub" style={{ display: "block", marginTop: 10, marginBottom: 4 }}>
        Type {label} to confirm
      </label>
      <input id={`del-confirm-${label}`} className="field" style={{ maxWidth: 220 }} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <label htmlFor={`del-reason-${label}`} className="sub" style={{ display: "block", marginTop: 10, marginBottom: 4 }}>
        Reason (required — kept in the audit trail)
      </label>
      <textarea id={`del-reason-${label}`} className="field" rows={2} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy || !armed} onClick={() => onDelete(reason.trim())}>
          Delete permanently
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The §10.4 Move to trash confirm: a reason only — the type-back friction belongs to the
 *  irreversible action. */
function MoveToTrashConfirm({
  label,
  what,
  busy,
  onTrash,
  onCancel,
}: {
  label: string;
  what: string;
  busy: boolean;
  onTrash: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div role="dialog" aria-label={`Move ${label} to the trash`}>
      <p style={{ fontSize: 14, margin: "0 0 6px", fontWeight: 600 }}>Move {label} to the trash?</p>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
        This hides {what} from everyone at once. It will be deleted permanently after 30 days unless a platform admin restores
        it. Nobody is notified.
      </p>
      <label htmlFor={`trash-reason-${label}`} className="sub" style={{ display: "block", marginTop: 10, marginBottom: 4 }}>
        Reason (required — kept in the audit trail)
      </label>
      <textarea id={`trash-reason-${label}`} className="field" rows={2} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy || reason.trim() === ""} onClick={() => onTrash(reason.trim())}>
          Move to trash
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * §10.3/§10.4 danger zone on a live item, platform admins only: Move to trash (the primary
 * action) and Delete permanently. `what` names what goes with it, for both confirms.
 */
export function DangerZone({
  label,
  what,
  note,
  busy,
  canTrash,
  onTrash,
  onDelete,
}: {
  label: string;
  what: string;
  note?: string;
  busy: boolean;
  canTrash: boolean;
  onTrash: (reason: string) => Promise<void>;
  onDelete: (reason: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"closed" | "trash" | "delete">("closed");
  const close = () => setMode("closed");
  return (
    <div style={SECTION}>
      {mode === "closed" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {canTrash && (
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setMode("trash")}>
              Move {label} to trash
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setMode("delete")}>
            Delete {label} permanently
          </button>
        </div>
      )}
      {mode === "trash" && (
        <MoveToTrashConfirm
          label={label}
          what={what}
          busy={busy}
          onCancel={close}
          onTrash={async (reason) => {
            await onTrash(reason);
            close();
          }}
        />
      )}
      {mode === "delete" && (
        <DeletePermanentlyConfirm
          label={label}
          what={what}
          note={note}
          busy={busy}
          onCancel={close}
          onDelete={async (reason) => {
            await onDelete(reason);
            close();
          }}
        />
      )}
    </div>
  );
}

/**
 * §10.4 banner over a trashed challenge (the read-only trashed view) or a trashed solution: when
 * the worker will purge it, who trashed it and why, and Restore / Delete permanently. A solution
 * whose challenge is also trashed shows Restore disabled, with the reason as its tooltip.
 */
export function TrashedBanner({
  kind,
  label,
  what,
  trashed,
  restoreBlocked = false,
  busy,
  onRestore,
  onDelete,
}: {
  kind: "challenge" | "solution";
  label: string;
  what: string;
  trashed: TrashInfo;
  restoreBlocked?: boolean;
  busy: boolean;
  onRestore: () => Promise<void>;
  onDelete: (reason: string) => Promise<void>;
}) {
  const fmt = useDateFmt();
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="trash-banner" role="status" data-testid={`trash-banner-${label}`}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        This {kind} is in the trash. It will be deleted permanently on {fmt.date(trashed.purgesOn)}.
      </p>
      <p className="sub" style={{ margin: "4px 0 0" }}>
        Moved to the trash by {trashed.by || "a platform admin"} on {fmt.dateTime(trashed.at)} — “{trashed.reason}”
      </p>
      {deleting ? (
        <div style={{ marginTop: 12 }}>
          <DeletePermanentlyConfirm
            label={label}
            what={what}
            busy={busy}
            onCancel={() => setDeleting(false)}
            onDelete={async (reason) => {
              await onDelete(reason);
              setDeleting(false);
            }}
          />
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {/* A disabled button fires no hover events in every browser, so the tooltip sits on a wrapper. */}
          <span title={restoreBlocked ? RESTORE_CHALLENGE_FIRST : undefined}>
            <button
              type="button"
              className="btn btn-sm btn-primary trash-restore"
              disabled={busy || restoreBlocked}
              onClick={() => {
                void onRestore();
              }}
            >
              Restore
            </button>
          </span>
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setDeleting(true)}>
            Delete permanently
          </button>
        </div>
      )}
    </div>
  );
}
