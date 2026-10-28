"use client";
// In-app notification bell (INNOBOX_SPEC.md §12.2): unread count, newest-first list,
// mark-read (click) and mark-all-read. The count comes from the shell's §12.2 pulse. Reuses the
// .bell/.msg-* class contract from globals.css (carried-over messaging pattern) — no new CSS.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDateFmt } from "@/components/DateFormat";

interface NotificationItem {
  id: string;
  type: string;
  message: string;
  /** §40.6: a muted second line — an invitation's quoted note. */
  detail?: string | null;
  link: string;
  read: boolean;
  createdAt: string;
}

/** §12.2 (v1.18): the badge shows `unreadCount` from the shell's pulse — the bell itself never
 *  polls. Its list is fetched when the panel opens and again after mark-all-read; that response
 *  carries the unread count too, handed back through `onUnreadCount` so badge and list agree. A
 *  mark action also dispatches `innobox:pulse`, re-reading the pulse at once. `onOpenChange`
 *  reports the panel's open state — on mobile it is a full sheet, which keeps the §13.10 survey
 *  card off screen. */
export function NotificationBell({
  unreadCount,
  onUnreadCount,
  onOpenChange,
}: { unreadCount: number; onUnreadCount?: (count: number) => void; onOpenChange?: (open: boolean) => void }) {
  const router = useRouter();
  const fmt = useDateFmt();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const loadList = () => {
    fetch("/api/notifications", { headers: { accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!json) return;
        setItems(json.notifications);
        if (typeof json.unreadCount === "number") onUnreadCount?.(json.unreadCount);
      })
      .catch(() => {});
  };

  const refreshPulse = () => window.dispatchEvent(new Event("innobox:pulse"));

  // The list is not polled: it loads each time the panel opens.
  useEffect(() => {
    if (open) loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load on open only
  }, [open]);

  useEffect(() => {
    onOpenChange?.(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report changes of `open` only
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const markAllRead = async () => {
    await fetch("/api/notifications", { method: "PATCH" });
    loadList();
    refreshPulse();
  };

  const openItem = async (item: NotificationItem) => {
    setOpen(false);
    if (!item.read) {
      await fetch(`/api/notifications/${item.id}`, { method: "PATCH" });
      refreshPulse();
    }
    router.push(item.link);
  };

  return (
    <div className="msg-menu" ref={rootRef}>
      <button type="button" className="bell" aria-label="Notifications" onClick={() => setOpen((v) => !v)}>
        <span aria-hidden="true" style={{ fontSize: 15, lineHeight: 1 }}>🔔</span>
        {unreadCount > 0 && <span className="bell-dot">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>
      {open && (
        <div className="msg-panel menu-pop" role="menu">
          <div className="msg-panel-head">
            <strong style={{ flex: 1, fontSize: 14 }}>Notifications</strong>
            {unreadCount > 0 && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={markAllRead}>
                Mark all read
              </button>
            )}
            <button type="button" className="msg-close" aria-label="Close" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {!items && <p className="muted" style={{ padding: 16 }}>Loading…</p>}
            {items && items.length === 0 && (
              <p className="muted" style={{ padding: 16 }}>
                No notifications yet.
              </p>
            )}
            {items &&
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openItem(item)}
                  className="row"
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: item.read ? undefined : "var(--accent-soft)",
                    border: 0,
                    borderBottom: "1px solid var(--line)",
                    cursor: "pointer",
                  }}
                >
                  <div className="grow">
                    <div className="ttl" style={{ fontWeight: item.read ? 400 : 600 }}>
                      {item.message}
                    </div>
                    {item.detail && <div className="sub notification-detail">{item.detail}</div>}
                    <div className="sub mono">{fmt.dateTime(item.createdAt)}</div>
                  </div>
                </button>
              ))}
          </div>
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--line)", textAlign: "center" }}>
            <Link href="/profile" className="mono" style={{ fontSize: 12 }} onClick={() => setOpen(false)}>
              Manage email notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
