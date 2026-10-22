"use client";
// Hype (INNOBOX_SPEC.md §26.5): the button and the hypers list on the challenge detail page, the
// count chip on cards, and the Home "Hyped this week" board. Everything shown here comes from the
// API — the button's state from `canHype` / `hypeReason`, the budget from `hypesLeft` — so the
// client computes no rule. Hypers are public by design; the item's author arrives already masked.
import Link from "next/link";
import { useState } from "react";
import { HYPERS_SHOWN, HYPE_MESSAGES, hypeBudgetLine, hypeButtonLabel, hypeTooltip, type HypeReason } from "@innobox/shared/hype";
import { AvatarBubble } from "@/components/AvatarBubble";
import { TeamByline, teamOf, type TeamPerson } from "@/components/TeamByline";
import { CHALLENGE_STATUS_LABEL, SOLUTION_STATUS_LABEL, statusPillClass } from "@/app/challenges/status";

export const HYPE_GLYPH = "🔥";

export interface Hyper {
  id: string;
  displayName: string;
  deactivated: boolean;
  scrubbed: boolean;
}

/** The hype fields an item carries on the detail payload while hype is on. */
export interface HypeFields {
  hype: number;
  hyped: boolean;
  canHype: boolean;
  hypeReason: HypeReason;
  hypeEarly: boolean;
  hypers: Hyper[];
}

/** The read-only count — cards, list rows, triage, a closed item's header. 0 is shown. */
export function HypeCount({ value, className = "chip" }: { value: number; className?: string }) {
  return (
    <span className={className} title={`${value} hype`} aria-label={`${value} hype`} data-testid="hype-count">
      {HYPE_GLYPH} {value}
    </span>
  );
}

/**
 * The detail-page control (§26.3): hidden — only the count shows — when the item is closed or
 * the viewer's own; pressed and disabled once hyped; disabled with the reset hint when the week's
 * budget is spent; otherwise a button that spends one hype. A hype cannot be taken back, which the
 * tooltip says before the click.
 */
export function HypeButton({
  item,
  hypesLeft,
  busy,
  onHype,
}: {
  item: HypeFields;
  hypesLeft: number;
  busy: boolean;
  onHype: () => void;
}) {
  const count = <HypeCount value={item.hype} className="sub mono hype-count" />;
  if (item.hypeReason === "closed" || item.hypeReason === "own") return count;
  if (item.hypeReason === "hyped") {
    return (
      <>
        {count}
        <button type="button" className="btn btn-sm hype-btn is-on" disabled aria-pressed="true" title="You hyped this">
          {HYPE_GLYPH} Hyped
        </button>
      </>
    );
  }
  if (item.hypeReason === "budget") {
    return (
      <>
        {count}
        <button type="button" className="btn btn-sm hype-btn" disabled aria-pressed="false" title={HYPE_MESSAGES.budget}>
          {hypeButtonLabel(0)}
        </button>
      </>
    );
  }
  const tip = `${hypeTooltip(item.hypeEarly)}. A hype can't be taken back.`;
  return (
    <>
      {count}
      <button type="button" className="btn btn-sm hype-btn" disabled={busy} aria-pressed="false" title={tip} aria-label={`${hypeButtonLabel(hypesLeft)}. ${tip}`} onClick={onHype}>
        {HYPE_GLYPH} {hypeButtonLabel(hypesLeft)}
      </button>
    </>
  );
}

/** Who hyped the item, newest first: the first 12 bubbles and "+N" to expand (§26.5). */
export function HypersList({ hypers }: { hypers: Hyper[] }) {
  const [expanded, setExpanded] = useState(false);
  if (hypers.length === 0) return null;
  const shown = expanded ? hypers : hypers.slice(0, HYPERS_SHOWN);
  const more = hypers.length - shown.length;
  return (
    <div className="hypers" aria-label="Hyped by" data-testid="hypers">
      <span className="sub">Hyped by</span>
      <span className="hypers-bubbles">
        {shown.map((h) => (
          <AvatarBubble key={h.id} size="sm" userId={h.id} displayName={h.displayName} deactivated={h.deactivated} scrubbed={h.scrubbed} />
        ))}
      </span>
      {more > 0 && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded(true)} aria-label={`Show ${more} more`}>
          +{more}
        </button>
      )}
    </div>
  );
}

export interface HypedBoardItem {
  type: "challenge" | "solution";
  number: string;
  title: string;
  parentTitle?: string;
  challengeNumber: string;
  author: { userId: string | null; displayName: string; anonymous: boolean; active?: boolean; scrubbed?: boolean; external?: boolean };
  /** §39.7: every member in order, masked — the compact form. */
  authors?: TeamPerson[];
  status: string;
  points: number;
}

export interface HypedBoard {
  weekStart: string;
  hypesLeft: number;
  items: HypedBoardItem[];
}

/** Home → "Hyped this week" (§26.5): nothing at all — no heading, no empty state — when the viewer
 *  can see no item hyped this week, exactly like Featured. */
export function HypedThisWeek({ board }: { board: HypedBoard | null | undefined }) {
  if (!board || board.items.length === 0) return null;
  return (
    <section aria-labelledby="home-hyped-heading" style={{ marginBottom: 18 }} data-testid="hyped-this-week">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", margin: "0 0 12px" }}>
        <h2 id="home-hyped-heading" style={{ fontFamily: "var(--font-display)", fontSize: 19, margin: 0 }}>
          Hyped this week
        </h2>
        <span className="sub">{hypeBudgetLine(board.hypesLeft)}</span>
      </div>
      <div className="card rows hyped-rows">
        {board.items.map((item) => {
          const href = `/challenges/${item.challengeNumber.replace("CH-", "")}${item.type === "solution" ? `#${item.number}` : ""}`;
          const label = item.type === "solution" ? SOLUTION_STATUS_LABEL[item.status] : CHALLENGE_STATUS_LABEL[item.status];
          return (
            <Link key={item.number} href={href} className="row hyped-row" data-testid="hyped-row">
              <span className="chip mono">{item.number}</span>
              <span className="hyped-title">
                <span className="ttl">{item.title}</span>
                {item.parentTitle && <span className="sub">on {item.parentTitle}</span>}
                <span className="hyped-meta">
                  <TeamByline className="sub hyped-author" authors={teamOf(item)} />
                  <span className={statusPillClass(item.status)}>{label ?? item.status}</span>
                </span>
              </span>
              <span className="hyped-points" aria-label={`${item.points} hype this week`}>
                {HYPE_GLYPH} {item.points}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
