"use client";
// Another user's public profile (INNOBOX_SPEC.md §13.5): display name, department, job
// title, office location, and their non-anonymous org-visible contributions only — the API
// already applies that filter, so this page has nothing extra to hide. This page is the
// CANONICAL view of the directory profile; the hover card (§13.8) shows the same three fields
// and never more.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CHALLENGE_STATUS_LABEL, SOLUTION_STATUS_LABEL } from "../../challenges/status";
import { AvatarBubble } from "@/components/AvatarBubble";

interface PublicProfile {
  user: { id: string; displayName: string; department: string | null; jobTitle: string | null; officeLocation: string | null };
  contributions: {
    challenges: { number: string; title: string; status: string }[];
    solutions: { number: string; description: string; status: string; challengeNumber: string }[];
  };
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

  return (
    <>
      <div className="page-head reveal" style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <AvatarBubble size="lg" userId={profile.user.id} displayName={profile.user.displayName} />
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">Profile</div>
          <h1 className="page-title">{profile.user.displayName}</h1>
          <p className="page-sub">
            {[profile.user.jobTitle, profile.user.department, profile.user.officeLocation].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
      </div>

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
