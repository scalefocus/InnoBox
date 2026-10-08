"use client";
// Home → "Featured" (INNOBOX_SPEC.md §13.2 *Featured challenges*): the challenges a platform admin
// pinned, newest pin first, as §13.1 gallery cards. The API has already applied the viewer's
// visibility (invariant 2) and author masking (invariant 3); when nothing is visible this renders
// nothing at all — no heading, no empty state.
import Link from "next/link";
import { AvatarBubble } from "@/components/AvatarBubble";
import { CHALLENGE_STATUS_LABEL, statusPillClass } from "@/app/challenges/status";

export interface FeaturedChallengeCard {
  id: string;
  number: string;
  title: string;
  author: { userId: string | null; displayName: string; anonymous: boolean };
  impactAreaName: string;
  status: string;
  likeCount: number;
  solutionCount: number;
  /** §13.10 Committee pick — present once list rows carry it. */
  endorsed?: boolean;
}

export function FeaturedChallenges({ items }: { items: FeaturedChallengeCard[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="home-featured-heading" style={{ marginBottom: 18 }}>
      <h2 id="home-featured-heading" style={{ fontFamily: "var(--font-display)", fontSize: 19, margin: "0 0 12px" }}>
        Featured
      </h2>
      <div className="card-grid">
        {items.map((c) => (
          <Link key={c.id} href={`/challenges/${c.number.replace("CH-", "")}`} className="card skill-card" data-testid="featured-card">
            <div className="meta">
              <span className="chip mono">{c.number}</span>
              <span className={statusPillClass(c.status)}>{CHALLENGE_STATUS_LABEL[c.status] ?? c.status}</span>
              <span className="chip">{c.impactAreaName}</span>
              {c.endorsed && <span className="chip chip-accent">Committee pick</span>}
            </div>
            <h3>{c.title}</h3>
            <div className="desc" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AvatarBubble size="sm" userId={c.author.userId} displayName={c.author.displayName} anonymous={c.author.anonymous} />
              <span>{c.author.anonymous ? "Anonymous" : c.author.displayName}</span>
            </div>
            <div className="meta">
              <span className="chip">❤ {c.likeCount}</span>
              <span className="chip">
                {c.solutionCount} solution{c.solutionCount === 1 ? "" : "s"}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
