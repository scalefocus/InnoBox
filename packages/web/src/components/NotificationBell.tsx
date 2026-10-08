"use client";
// In-app notification bell (INNOBOX_SPEC.md §12.2): unread count, newest-first list,
// mark-read (click) and mark-all-read. Reuses the .bell/.msg-* class contract from
// globals.css (carried-over messaging pattern) — no new CSS.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface NotificationItem {
  id: string;
  type: string;
  message: string;
  link: string;
  read: boolean;
  createdAt: string;
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = () => {
    fetch("/api/notifications", { headers: { accept: "application/json" } })
      .then((res) => res.json())
      .then((json) => {
        setItems(json.notifications);
        setUnreadCount(json.unreadCount);
      })
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(interval);
  }, []);

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
    refresh();
  };

  const openItem = async (item: NotificationItem) => {
    setOpen(false);
    if (!item.read) {
      await fetch(`/api/notifications/${item.id}`, { method: "PATCH" });
      refresh();
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
                    <div className="sub mono">{new Date(item.createdAt).toLocaleString()}</div>
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
