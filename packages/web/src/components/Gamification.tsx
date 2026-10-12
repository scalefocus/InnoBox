"use client";
// Gamification surfaces (INNOBOX_SPEC.md §23.5, §23.6): the level card, the "Currently leading"
// strip, badge tiles, the compact level chip and the leader glyphs shared by the profile pages, the
// hover card and the leaderboard. Pure presentation — every payload arrives already masked by the
// API (null when the feature is off or the person hides it), and nothing here ever names the item
// behind an award.
import { LEADER_GLYPH, leaderBadgeLabel, type LeaderBadge } from "@innobox/shared/gamification";
import { useDateFmt } from "./DateFormat";

export interface LevelData {
  points: number;
  level: number;
  levelName: string;
  progress: number;
  next: { level: number; name: string; pointsNeeded: number } | null;
}

export interface EarnedBadgeData {
  badgeKey: string;
  name: string;
  criterion: string;
  tier: 1 | 2 | 3 | null;
  tierName: string | null;
  earnedAt: string;
  progress?: string | null;
}

export interface LockedBadgeData {
  badgeKey: string;
  name: string;
  criterion: string;
  progress: string | null;
}

const BADGE_GLYPH: Record<string, string> = {
  problem_spotter: "🔎",
  solution_architect: "📐",
  implementer: "🛠️",
  challenge_closer: "✅",
  champion: "🏅",
  crowd_favorite: "👏",
  conversation_starter: "💬",
  icebreaker: "🧊",
  first_idea: "✨",
  full_circle: "⭕",
};

export function badgeGlyph(key: string): string {
  return BADGE_GLYPH[key] ?? "🏷️";
}

/** "Lv 4" on the leaderboard; "Lv 4 · Problem Solver" in the hover card. */
export function LevelChip({ level, levelName }: { level: number; levelName?: string }) {
  return (
    <span className="chip level-chip" title={levelName ? `Level ${level} — ${levelName}` : `Level ${level}`}>
      Lv {level}
      {levelName ? ` · ${levelName}` : ""}
    </span>
  );
}

/** The live leader badges: a glyph in a colored circle, with a crown for the all-time board. */
export function LeaderGlyphs({ leading }: { leading: LeaderBadge[] }) {
  if (leading.length === 0) return null;
  return (
    <span className="leader-glyphs">
      {leading.map((b) => {
        const g = LEADER_GLYPH[b.metric];
        const label = leaderBadgeLabel(b);
        return (
          <span
            key={`${b.metric}:${b.window}`}
            className="leader-glyph"
            style={{ ["--leader-color" as string]: g.color }}
            role="img"
            aria-label={label}
            title={label}
          >
            <span aria-hidden="true">{g.glyph}</span>
            {b.window === "all" && (
              <span className="leader-crown" aria-hidden="true">
                👑
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

/** Level number and name, total points, and the progress bar toward the next level. */
export function LevelCard({ data }: { data: LevelData }) {
  const pct = Math.round(data.progress * 100);
  return (
    <div className="level-card">
      <div className="level-num" aria-hidden="true">
        {data.level}
      </div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ttl">
          Level {data.level} · {data.levelName}
        </div>
        <div className="sub">{data.points} points</div>
        <div className="level-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progress to the next level">
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="sub">{data.next ? `${data.next.pointsNeeded} points to ${data.next.name}` : "Top level reached"}</div>
      </div>
    </div>
  );
}

/** The Achievements section body: level card, the leading strip, earned then (own view) locked badges. */
export function Achievements({
  level,
  leading,
  earned,
  locked,
}: {
  level: LevelData;
  leading: LeaderBadge[];
  earned: EarnedBadgeData[];
  locked?: LockedBadgeData[];
}) {
  const fmt = useDateFmt();
  return (
    <div className="card card-pad reveal achievements" style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 16, marginBottom: 12 }}>Achievements</h3>
      <LevelCard data={level} />
      {leading.length > 0 && (
        <div className="leading-strip">
          <span className="sub">Currently leading</span>
          <LeaderGlyphs leading={leading} />
        </div>
      )}
      {earned.length === 0 && !locked && <p className="muted" style={{ margin: "12px 0 0" }}>No badges yet.</p>}
      <div className="badge-grid">
        {earned.map((b) => (
          <div key={b.badgeKey} className={`badge-tile${b.tier ? ` tier-${b.tier}` : ""}`} title={b.criterion}>
            <span className="badge-glyph" aria-hidden="true">
              {badgeGlyph(b.badgeKey)}
            </span>
            <span className="badge-name">{b.name}</span>
            {b.tierName && <span className="badge-tier">{b.tierName}</span>}
            <span className="badge-meta">Earned {fmt.date(b.earnedAt)}</span>
            {b.progress && <span className="badge-meta">Next: {b.progress}</span>}
          </div>
        ))}
        {locked?.map((b) => (
          <div key={b.badgeKey} className="badge-tile locked" title={b.criterion}>
            <span className="badge-glyph" aria-hidden="true">
              {badgeGlyph(b.badgeKey)}
            </span>
            <span className="badge-name">{b.name}</span>
            <span className="badge-meta">{b.criterion}</span>
            {b.progress && <span className="badge-meta">{b.progress}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
