"use client";
// Minimal admin surface (ENTRA_AUTH_SPEC.md §5 layer 3): namespaces CRUD-lite + role
// mappings list/add/remove. Platform-admin-gated IN-PAGE against /api/me (middleware
// already forces sign-in; this page just decides what a signed-in non-admin sees).
// The full §14.3 settings page (search, pagination, richer editing) is Phase 4 — this
// stays functional, not fancy: reuses the .admin-card-*/.create-ns-form/.mapping-row/
// .rows/.row/.chip/.pill/.btn class contract from globals.css, no new CSS.
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cachedGet, invalidateApi } from "@/lib/ui";
import { deleteReq, patchJson, postJson } from "@/lib/api-client";
import { AvatarBubble } from "@/components/AvatarBubble";
import { CurrentlyOnline } from "./CurrentlyOnline";

const NAMESPACES_URL = "/api/admin/namespaces";
const ROLE_MAPPINGS_URL = "/api/admin/role-mappings";

// The admin console's collapsible cards remember their open/closed state per browser
// (localStorage) so a chosen layout survives reloads. Default: everything expanded.
const ADMIN_CARDS_STORAGE_KEY = "innobox:admin-cards-open";
const DEFAULT_ADMIN_CARDS: Record<string, boolean> = { presence: true, namespaces: true, mappings: true };
const ADMIN_CARD_IDS = Object.keys(DEFAULT_ADMIN_CARDS);

function loadAdminCardState(): Record<string, boolean> {
  if (typeof window === "undefined") return { ...DEFAULT_ADMIN_CARDS };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ADMIN_CARDS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(
      ADMIN_CARD_IDS.map((id) => [id, typeof parsed[id] === "boolean" ? (parsed[id] as boolean) : true]),
    );
  } catch {
    return { ...DEFAULT_ADMIN_CARDS };
  }
}

interface MeResponse {
  roles: { platformAdmin: boolean; namespaceAdmin: string[] };
}

interface NamespaceRecord {
  id: string;
  slug: string;
  displayName: string;
  archivedAt: string | null;
  createdAt: string;
}

type Role = "platform_admin" | "namespace_admin" | "committee" | "member";

interface RoleMappingRecord {
  id: string;
  groupExternalId: string;
  groupDisplayName: string | null;
  dead: boolean;
  role: Role;
  namespaceId: string | null;
  namespaceSlug: string | null;
  createdAt: string;
}

const ROLE_LABEL: Record<Role, string> = {
  platform_admin: "Platform admin",
  namespace_admin: "Namespace admin",
  committee: "Committee",
  member: "Member",
};


export default function AdminPage() {
  const [gate, setGate] = useState<"loading" | "forbidden" | "namespace_admin" | "platform_admin">("loading");

  useEffect(() => {
    let live = true;
    cachedGet<MeResponse>("/api/me")
      .then((me) => {
        if (!live) return;
        if (me.roles.platformAdmin) setGate("platform_admin");
        else if (me.roles.namespaceAdmin.length > 0) setGate("namespace_admin");
        else setGate("forbidden");
      })
      .catch(() => {
        if (live) setGate("forbidden");
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <div className="page-head reveal">
        <div className="eyebrow">Administration</div>
        <h1 className="page-title">Administration</h1>
        <p className="page-sub">Namespace triage, namespaces &amp; role mappings, and platform settings. Every change here is audited.</p>
      </div>

      {gate === "loading" && <p className="muted">Loading…</p>}

      {gate === "forbidden" && (
        <div className="card card-pad empty reveal">
          <div className="ico">🔒</div>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: 19, marginBottom: 8 }}>
            Administration is restricted
          </h3>
          <p className="muted" style={{ margin: 0 }}>
            You need namespace admin or platform admin rights to view this page.
          </p>
        </div>
      )}

      {(gate === "namespace_admin" || gate === "platform_admin") && (
        <div className="card-grid" style={{ marginBottom: 18 }}>
          <Link href="/admin/triage" className="card card-pad">
            <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 6 }}>Triage queue →</h3>
            <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Filter, assign, bulk-update, and export challenges.</p>
          </Link>
          {gate === "platform_admin" && (
            <Link href="/admin/settings" className="card card-pad">
              <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 6 }}>Platform settings →</h3>
              <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Impact areas, date format, attachment limits, notification sender.</p>
            </Link>
          )}
          {gate === "platform_admin" && (
            <Link href="/admin/audit" className="card card-pad">
              <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 6 }}>Audit log →</h3>
              <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Read-only, filterable history of every audited action.</p>
            </Link>
          )}
          {gate === "platform_admin" && <SystemLogCard />}
        </div>
      )}

      {gate === "platform_admin" && <AdminConsole />}
    </>
  );
}

/** The §14.7 console card: links to the system log and carries a 1–9+ badge of events recorded
 *  since this admin last opened it (cleared by opening the page). */
function SystemLogCard() {
  const [unseen, setUnseen] = useState(0);
  useEffect(() => {
    let live = true;
    fetch("/api/admin/system-log/seen", { headers: { accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (live && json) setUnseen(json.count ?? 0);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <Link href="/admin/system-log" className="card card-pad">
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
        System log →
        {unseen > 0 && (
          <span className="nav-badge" style={{ marginLeft: 0 }} aria-label={`${unseen} new event${unseen === 1 ? "" : "s"}`}>
            {unseen > 9 ? "9+" : unseen}
          </span>
        )}
      </h3>
      <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>The errors people hit — server failures and refused requests — kept for 90 days.</p>
    </Link>
  );
}

function AdminConsole() {
  const [namespaces, setNamespaces] = useState<NamespaceRecord[] | null>(null);
  const [mappings, setMappings] = useState<RoleMappingRecord[] | null>(null);
  const [openCards, setOpenCards] = useState<Record<string, boolean>>(loadAdminCardState);
  const [onlineTotal, setOnlineTotal] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 3200);
  };

  const refreshNamespaces = () => {
    invalidateApi(NAMESPACES_URL);
    cachedGet<{ namespaces: NamespaceRecord[] }>(NAMESPACES_URL)
      .then((j) => setNamespaces(j.namespaces))
      .catch(() => notify("Could not load namespaces"));
  };

  const refreshMappings = () => {
    invalidateApi(ROLE_MAPPINGS_URL);
    cachedGet<{ mappings: RoleMappingRecord[] }>(ROLE_MAPPINGS_URL)
      .then((j) => setMappings(j.mappings))
      .catch(() => notify("Could not load role mappings"));
  };

  useEffect(() => {
    refreshNamespaces();
    refreshMappings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the collapse layout across reloads (per browser).
  useEffect(() => {
    try {
      window.localStorage.setItem(ADMIN_CARDS_STORAGE_KEY, JSON.stringify(openCards));
    } catch {
      /* localStorage unavailable (private mode / quota) — non-fatal, just don't persist */
    }
  }, [openCards]);

  const toggleCard = (id: string) => setOpenCards((cur) => ({ ...cur, [id]: !cur[id] }));
  const allOpen = Object.values(openCards).every(Boolean);
  const setAll = (open: boolean) => setOpenCards(Object.fromEntries(ADMIN_CARD_IDS.map((id) => [id, open])));

  return (
    <>
      <div className="admin-bulk">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAll(!allOpen)}>
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>

      <AdminCard
        id="presence"
        title="Currently online"
        summary={onlineTotal === null ? "…" : `${onlineTotal} ${onlineTotal === 1 ? "user" : "users"}`}
        open={openCards.presence ?? true}
        onToggle={() => toggleCard("presence")}
      >
        <CurrentlyOnline onTotal={setOnlineTotal} />
      </AdminCard>

      <AdminCard
        id="namespaces"
        title="Namespaces"
        summary={namespaces ? `${namespaces.length}` : "…"}
        open={openCards.namespaces ?? true}
        onToggle={() => toggleCard("namespaces")}
      >
        <NamespacesPanel
          namespaces={namespaces}
          onChanged={refreshNamespaces}
          onError={notify}
        />
      </AdminCard>

      <AdminCard
        id="mappings"
        title="Role mappings"
        summary={mappings ? `${mappings.length}` : "…"}
        open={openCards.mappings ?? true}
        onToggle={() => toggleCard("mappings")}
      >
        <RoleMappingsPanel
          mappings={mappings}
          namespaces={namespaces ?? []}
          onChanged={refreshMappings}
          onError={notify}
        />
      </AdminCard>

      <GDPRCard onNotify={notify} />

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

function AdminCard({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="card reveal" style={{ marginBottom: 18 }}>
      <button type="button" className="admin-card-head" onClick={onToggle} aria-expanded={open}>
        <h3 className="admin-card-title" style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
          {title}
        </h3>
        <span className="admin-card-accessory">
          <span className="chip">{summary}</span>
        </span>
        <span className="admin-card-chevron" data-open={open} aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>
      <div className="admin-card-body" data-open={open}>
        <div className="admin-card-body-inner">
          <div className="admin-card-body-pad">{children}</div>
        </div>
      </div>
    </div>
  );
}

function NamespacesPanel({
  namespaces,
  onChanged,
  onError,
}: {
  namespaces: NamespaceRecord[] | null;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  // Seed per-row rename drafts from freshly-loaded namespaces without clobbering an
  // in-progress, unsaved edit on refetch.
  useEffect(() => {
    if (!namespaces) return;
    setDrafts((cur) => {
      const next = { ...cur };
      for (const ns of namespaces) {
        if (!(ns.id in next)) next[ns.id] = ns.displayName;
      }
      return next;
    });
  }, [namespaces]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await postJson(NAMESPACES_URL, { slug: slug.trim(), displayName: displayName.trim() });
      setSlug("");
      setDisplayName("");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create namespace");
    } finally {
      setCreating(false);
    }
  };

  const rename = async (ns: NamespaceRecord) => {
    const next = drafts[ns.id]?.trim();
    if (!next || next === ns.displayName) return;
    setBusyId(ns.id);
    try {
      await patchJson(`${NAMESPACES_URL}/${ns.id}`, { displayName: next });
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not rename namespace");
    } finally {
      setBusyId(null);
    }
  };

  const setArchived = async (ns: NamespaceRecord, archived: boolean) => {
    setBusyId(ns.id);
    try {
      await patchJson(`${NAMESPACES_URL}/${ns.id}`, { archived });
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update namespace");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <form className="create-ns-form" onSubmit={onCreate} style={{ marginBottom: 16 }}>
        <input
          className="field"
          placeholder="slug (e.g. sales)"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          required
        />
        <input
          className="field"
          placeholder="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={creating}>
          Create namespace
        </button>
      </form>

      {!namespaces && <p className="muted">Loading namespaces…</p>}
      {namespaces && namespaces.length === 0 && <p className="muted">No namespaces yet.</p>}
      {namespaces && namespaces.length > 0 && (
        <div className="rows">
          {namespaces.map((ns) => {
            const draft = drafts[ns.id] ?? ns.displayName;
            const dirty = draft.trim() !== "" && draft.trim() !== ns.displayName;
            const busy = busyId === ns.id;
            return (
              <div className="row" key={ns.id} style={{ flexWrap: "wrap" }}>
                <div className="grow">
                  <input
                    className="field"
                    style={{ width: "100%", maxWidth: 320 }}
                    value={draft}
                    onChange={(e) => setDrafts((cur) => ({ ...cur, [ns.id]: e.target.value }))}
                    aria-label={`Display name for ${ns.slug}`}
                  />
                  <div className="sub mono">/{ns.slug}</div>
                </div>
                {ns.archivedAt ? (
                  <span className="pill pill-muted">Archived</span>
                ) : (
                  <span className="pill pill-ok">Active</span>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!dirty || busy}
                  onClick={() => rename(ns)}
                >
                  Save
                </button>
                {ns.slug === "global" ? (
                  <span className="chip">Built-in</span>
                ) : ns.archivedAt ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => setArchived(ns, false)}
                  >
                    Unarchive
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy}
                    onClick={() => setArchived(ns, true)}
                  >
                    Archive
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function RoleMappingsPanel({
  mappings,
  namespaces,
  onChanged,
  onError,
}: {
  mappings: RoleMappingRecord[] | null;
  namespaces: NamespaceRecord[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [groupExternalId, setGroupExternalId] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [namespaceId, setNamespaceId] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const namespaceOptions = useMemo(() => namespaces.filter((ns) => !ns.archivedAt), [namespaces]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await postJson(ROLE_MAPPINGS_URL, {
        groupExternalId: groupExternalId.trim(),
        role,
        namespaceId: role === "platform_admin" ? null : namespaceId || null,
      });
      setGroupExternalId("");
      setNamespaceId("");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add role mapping");
    } finally {
      setCreating(false);
    }
  };

  const remove = async (mapping: RoleMappingRecord) => {
    setBusyId(mapping.id);
    try {
      await deleteReq(`${ROLE_MAPPINGS_URL}/${mapping.id}`);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not remove role mapping");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <form className="add-mapping create-ns-form" onSubmit={onCreate} style={{ marginBottom: 16 }}>
        <input
          className="field"
          style={{ flex: 1, minWidth: 220 }}
          placeholder="Entra group object id"
          value={groupExternalId}
          onChange={(e) => setGroupExternalId(e.target.value)}
          required
        />
        <select className="field" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        {role !== "platform_admin" && (
          <select
            className="field"
            value={namespaceId}
            onChange={(e) => setNamespaceId(e.target.value)}
            required
          >
            <option value="">Select namespace…</option>
            {namespaceOptions.map((ns) => (
              <option key={ns.id} value={ns.id}>
                {ns.slug}
              </option>
            ))}
          </select>
        )}
        <button type="submit" className="btn btn-primary btn-sm" disabled={creating}>
          Add mapping
        </button>
      </form>

      {!mappings && <p className="muted">Loading role mappings…</p>}
      {mappings && mappings.length === 0 && <p className="muted">No role mappings yet.</p>}
      {mappings && mappings.length > 0 && (
        <div className="rows">
          {mappings.map((m) => (
            <div className="row mapping-row" key={m.id}>
              <div className="grow">
                <div className="ttl">
                  {m.dead ? <span className="pill pill-danger">Dead</span> : m.groupDisplayName}
                </div>
                <div className="sub mono">{m.groupExternalId}</div>
              </div>
              <span className="chip chip-accent">{ROLE_LABEL[m.role]}</span>
              <span className="pill pill-muted">{m.namespaceSlug ?? "platform"}</span>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busyId === m.id}
                onClick={() => remove(m)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function GDPRCard({ onNotify }: { onNotify: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; displayName: string; email: string | null; active: boolean; scrubbed: boolean }[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const search = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      const res = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`, { headers: { accept: "application/json" } });
      const json = await res.json();
      setResults(json.users ?? []);
    } catch {
      setResults([]);
    }
  };

  const scrub = async (u: { id: string; displayName: string }) => {
    if (!window.confirm(`Permanently delete all personal info for “${u.displayName}”? Their name becomes “Deleted User” on every challenge, solution, and comment, and this cannot be undone.`)) return;
    setBusyId(u.id);
    try {
      await postJson(`/api/admin/users/${u.id}/scrub`, {});
      onNotify(`Deleted personal info for ${u.displayName}.`);
      setQuery("");
      setResults([]);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : "Could not delete user info");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 6 }}>Delete user info (GDPR)</h3>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
        Irreversibly de-identifies a user: their name becomes “Deleted User” on every challenge, solution, and comment, personal
        fields are erased, and the account is deactivated. The append-only audit log is retained.
      </p>
      <input className="field" placeholder="Search users by name or email…" value={query} onChange={(e) => search(e.target.value)} />
      {results.length > 0 && (
        <div className="rows" style={{ marginTop: 10 }}>
          {results.map((u) => (
            <div className="row" key={u.id}>
              <AvatarBubble size="sm" userId={u.scrubbed ? null : u.id} displayName={u.displayName} deactivated={!u.active} />
              <span className="grow">
                <span className="ttl">{u.displayName}</span> {u.email && <span className="muted mono">{u.email}</span>}
              </span>
              {!u.active && <span className="pill pill-muted">Inactive</span>}
              {u.scrubbed ? (
                <span className="chip">Deleted</span>
              ) : (
                <button type="button" className="btn btn-sm btn-danger" disabled={busyId === u.id} onClick={() => scrub(u)}>
                  Delete info
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
