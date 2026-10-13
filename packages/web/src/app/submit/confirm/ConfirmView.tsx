"use client";
// The confirmation step (INNOBOX_SPEC.md §24.5): a "Confirm my submission" button — never an
// automatic confirm on load — that POSTs the fragment's token. Success reads the thank-you line;
// anything else (unknown, expired, already used) the one generic invalid line. Once confirmed the
// fragment is dropped from the address bar, so the spent token is not left in the history.
import { useState, useSyncExternalStore } from "react";

type View = "ready" | "busy" | "done" | "invalid" | "error";

const INVALID = "This link is invalid or has expired.";

/** The fragment, read in the browser only (the server never sees it). */
const subscribeHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
const readHash = () => window.location.hash.replace(/^#/, "");
const serverHash = () => null;

export function ConfirmView() {
  const hash = useSyncExternalStore<string | null>(subscribeHash, readHash, serverHash);
  const token = hash || null;
  const [state, setView] = useState<View>("ready");
  const [message, setMessage] = useState<string | null>(null);
  // Until the browser has read the fragment the button waits; an empty fragment is an invalid link.
  const view: View | "loading" = hash === null ? "loading" : !token && state === "ready" ? "invalid" : state;

  const confirm = async () => {
    if (!token) return;
    setView("busy");
    setMessage(null);
    try {
      const res = await fetch("/api/public/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        window.history.replaceState(null, "", window.location.pathname);
        setView("done");
        return;
      }
      if (res.status === 410) {
        setView("invalid");
        return;
      }
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setMessage(json.error ?? "Something went wrong — try again later.");
      setView("error");
    } catch {
      setMessage("Something went wrong — check your connection and try again.");
      setView("error");
    }
  };

  if (view === "done") {
    return (
      <div className="public-done" role="status" data-testid="public-confirm-done">
        <h1 className="page-title">Thank you</h1>
        <p className="page-sub" style={{ marginLeft: "auto", marginRight: "auto" }}>
          Your submission is with our team. We&apos;ll e-mail you once it has been reviewed.
        </p>
      </div>
    );
  }

  if (view === "invalid") {
    return (
      <div className="public-done" role="alert" data-testid="public-confirm-invalid">
        <h1 className="page-title">Link not valid</h1>
        <p className="page-sub" style={{ marginLeft: "auto", marginRight: "auto" }}>
          {INVALID}
        </p>
      </div>
    );
  }

  return (
    <div className="public-done">
      <h1 className="page-title">Confirm your submission</h1>
      <p className="page-sub" style={{ marginLeft: "auto", marginRight: "auto" }}>
        Confirm that you sent this submission, and it goes to our team for review.
      </p>
      {message && (
        <div className="public-error" role="alert" style={{ margin: "16px auto 0", maxWidth: 480 }}>
          {message}
        </div>
      )}
      <button type="button" className="btn btn-primary" style={{ marginTop: 22 }} disabled={view !== "ready" && view !== "error"} onClick={confirm}>
        {view === "busy" ? "Confirming…" : "Confirm my submission"}
      </button>
    </div>
  );
}
