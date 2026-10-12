"use client";
// Another user's public profile (INNOBOX_SPEC.md §13.5): display name, department, job
// title, office location, and their non-anonymous org-visible contributions only — the API
// already applies that filter, so this page has nothing extra to hide. This page is the
// CANONICAL view of the directory profile; the hover card (§13.8) shows the same three fields
// and never more. A deactivated user's profile still renders — greyed bubble and a muted
// "Deactivated" notice — so the card's "View profile" link always lands somewhere; only a
// scrubbed user (or an unknown id) is the not-found state. While gamification is on and the user
// does not hide it (§23.6): their level card, leader badges and earned badges, and the level ring.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CHALLENGE_STATUS_LABEL, SOLUTION_STATUS_LABEL } from "../../challenges/status";
import { AvatarBubble } from "@/components/AvatarBubble";
import { Achievements, type EarnedBadgeData, type LevelData } from "@/components/Gamification";
import type { LeaderBadge } from "@innobox/shared/gamification";

interface PublicProfile {
  user: {
    id: string;
    displayName: string;
    department: string | null;
    jobTitle: string | null;
    officeLocation: string | null;
    active: boolean;
    scrubbed: boolean;
  };
  contributions: {
    challenges: { number: string; title: string; status: string }[];
    solutions: { number: string; description: string; status: string; challengeNumber: string }[];
  };
  /** §23.6 — null when the feature is off or the user hides it. */
  gamification: (LevelData & { leading: LeaderBadge[]; earned: EarnedBadgeData[] }) | null;
}

export default function PublicProfilePage() {
  const params = useParams<{ userId: string }>();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/profile/${params.userId}`, { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        const json = await res.json();
        setProfile(json.profile);
      })
      .catch(() => setNotFound(true));
  }, [params.userId]);

  if (notFound) {
    return (
      <div className="card card-pad empty reveal">
        <div className="ico">🔍</div>
        <p className="muted" style={{ margin: 0 }}>
          That profile doesn&apos;t exist.
        </p>
      </div>
    );
  }

  if (!profile) return <p className="muted">Loading…</p>;
  const g = profile.gamification;

  return (
    <>
      <div className="page-head reveal" style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <AvatarBubble
          size="lg"
          userId={profile.user.id}
          displayName={profile.user.displayName}
          deactivated={!profile.user.active}
          scrubbed={profile.user.scrubbed}
          ring={g ? { level: g.level, progress: g.progress, top: g.next === null } : null}
        />
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">Profile</div>
          <h1 className="page-title">{profile.user.displayName}</h1>
          <p className="page-sub">
            {[profile.user.jobTitle, profile.user.department, profile.user.officeLocation].filter(Boolean).join(" · ") || "—"}
          </p>
          {!profile.user.active && <span className="profile-deactivated">Deactivated</span>}
        </div>
      </div>

      {g && <Achievements level={g} leading={g.leading} earned={g.earned} />}

      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19, margin: "0 0 12px" }}>Challenges</h2>
      {profile.contributions.challenges.length === 0 && <p className="muted" style={{ marginBottom: 22 }}>No public challenges yet.</p>}
      {profile.contributions.challenges.length > 0 && (
        <div className="rows" style={{ marginBottom: 26 }}>
          {profile.contributions.challenges.map((c) => (
            <Link key={c.number} href={`/challenges/${c.number.replace("CH-", "")}`} className="row">
              <span className="chip mono">{c.number}</span>
              <span className="ttl grow">{c.title}</span>
              <span className="sub">{CHALLENGE_STATUS_LABEL[c.status] ?? c.status}</span>
            </Link>
          ))}
        </div>
      )}

      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19, margin: "0 0 12px" }}>Solutions</h2>
      {profile.contributions.solutions.length === 0 && <p className="muted">No public solutions yet.</p>}
      {profile.contributions.solutions.length > 0 && (
        <div className="rows">
          {profile.contributions.solutions.map((s) => (
            <Link key={s.number} href={`/challenges/${s.challengeNumber.replace("CH-", "")}`} className="row">
              <span className="chip mono">{s.number}</span>
              <span className="ttl grow">{s.description}</span>
              <span className="sub">{SOLUTION_STATUS_LABEL[s.status] ?? s.status}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
