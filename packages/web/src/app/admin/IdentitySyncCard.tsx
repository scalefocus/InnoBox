"use client";
// The "Identity sync" card body (INNOBOX_SPEC.md §14.10) — platform admin only; the card wrapper
// and the gate live in admin/page.tsx. Answers "is Entra provisioning reaching InnoBox, and is it
// sending what roles need?": provisioned user and group counts, mapped groups that never arrived,
// the last accepted and last rejected SCIM request, and at most one fixed explanation. Read-only.
import { useCallback, useEffect, useState } from "react";
import {
  IDENTITY_SYNC_EXPLANATIONS,
  UNARRIVED_GROUP_HINT,
  identitySyncSummaryLabel,
  type IdentitySyncState,
} from "@innobox/shared/identity-sync";
import { useDateFmt } from "@/components/DateFormat";
import { readJson } from "@/lib/api-client";
import { relativeActive } from "@/lib/presence";

const URL_ = "/api/admin/identity-sync";

type Role = "platform_admin" | "namespace_admin" | "committee" | "member";

const ROLE_LABEL: Record<Role, string> = {
  platform_admin: "Platform admin",
  namespace_admin: "Namespace admin",
  committee: "Committee",
  member: "Member",
};

interface IdentitySync {
  users: { active: number; deactivated: number };
  groups: number;
  unarrivedMappedGroups: { groupExternalId: string; role: Role; namespaceId: string | null; namespaceName: string | null }[];
  lastScimRequestAt: string | null;
  lastRejectedScimRequestAt: string | null;
  state: IdentitySyncState;
}

export function IdentitySyncCard({ onSummary }: { onSummary?: (label: string) => void }) {
  const fmt = useDateFmt();
  const [data, setData] = useState<IdentitySync | null>(null);
  // Relative times are judged against the moment the snapshot arrived (set in the fetch
  // callback, never during render).
  const [asOfMs, setAsOfMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every setState here runs in the fetch callbacks, never synchronously in the effect.
  const fetchSummary = useCallback(
    () =>
      fetch(URL_, { headers: { accept: "application/json" } })
        .then(async (res) => {
          const j = await readJson(res);
          if (!res.ok) throw new Error(j.error ?? `request failed (${res.status})`);
          const next = j as unknown as IdentitySync;
          setData(next);
          setAsOfMs(Date.now());
          setError(null);
          onSummary?.(identitySyncSummaryLabel({ users: next.users.active + next.users.deactivated, groups: next.groups }));
        })
        .catch(() => setError("Could not load the identity sync status.")),
    [onSummary],
  );

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  const refresh = () => {
    setBusy(true);
    void fetchSummary().finally(() => setBusy(false));
  };

  if (error && !data) return <p className="muted">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const explanation = IDENTITY_SYNC_EXPLANATIONS[data.state];
  const when = (iso: string | null, none: string) =>
    iso ? (
      <span title={fmt.dateTime(iso)}>{relativeActive(iso, asOfMs)}</span>
    ) : (
      <span className="muted">{none}</span>
    );

  return (
    <div className="identity-sync">
      <p className="muted" style={{ margin: "0 0 14px", fontSize: 13.5 }}>
        Whether Entra provisioning is reaching this site, and whether it sends the groups that roles come from.
      </p>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-num">{data.users.active}</div>
          <div className="stat-label">Provisioned users · active</div>
        </div>
        <div className="stat">
          <div className="stat-num">{data.users.deactivated}</div>
          <div className="stat-label">Provisioned users · deactivated</div>
        </div>
        <div className="stat">
          <div className="stat-num">{data.groups}</div>
          <div className="stat-label">Provisioned groups</div>
        </div>
      </div>

      <div className="identity-sync-times">
        <div>
          <span className="identity-sync-label">Last SCIM request</span> {when(data.lastScimRequestAt, "Never")}
        </div>
        <div>
          <span className="identity-sync-label">Last rejected SCIM request</span> {when(data.lastRejectedScimRequestAt, "None in the last 90 days")}
        </div>
      </div>

      {explanation && (
        <p className="identity-sync-explain" role="note">
          {explanation}
        </p>
      )}

      <h4 className="identity-sync-subhead">Mapped groups that never arrived</h4>
      {data.unarrivedMappedGroups.length === 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
          Every group used by a role mapping has arrived.
        </p>
      ) : (
        <div className="rows">
          {data.unarrivedMappedGroups.map((g) => (
            <div className="row" key={`${g.groupExternalId}|${g.role}|${g.namespaceId ?? ""}`}>
              <span className="grow">
                <span className="ttl mono">{g.groupExternalId}</span>
                <div className="sub">{UNARRIVED_GROUP_HINT}</div>
              </span>
              <span className="chip chip-accent">{ROLE_LABEL[g.role]}</span>
              <span className="chip">{g.namespaceName ?? "Platform"}</span>
            </div>
          ))}
        </div>
      )}

      <div className="identity-sync-foot">
        {error && <span className="muted">{error}</span>}
        <button type="button" className="btn btn-sm" onClick={refresh} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}
