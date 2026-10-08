"use client";
// List presentation of the Challenges gallery (INNOBOX_SPEC.md §13.1 "Cards / List view toggle").
// Renders the SAME payload as the cards — no extra data, no refetch — as a §14.1-style `.rows`
// table: number · title · status · namespace · author · likes · solutions · date. The whole row
// opens the challenge (the title stays the real link / keyboard target); text selection and
// clicks on interactive elements never navigate. Anonymity is the server's: an anonymous author
// arrives with userId null and renders the neutral bubble with no directory card (§9, §13.8).
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { useDateFmt } from "@/components/DateFormat";
import { AvatarBubble } from "@/components/AvatarBubble";
import { challengeHref, shouldRowNavigate, solutionCountLabel, type ChallengesView } from "@/lib/challenges-view";
import { CHALLENGE_STATUS_LABEL, statusPillClass } from "./status";
import { ChallengeAuthorName, ChallengeNewTag, ChallengeStateBadges, type ChallengeBadgeData } from "./ChallengeBadges";

/** The subset of the list payload a row reads (the page's list item satisfies it). */
export interface ChallengeRowData extends ChallengeBadgeData {
  id: string;
  number: string;
  title: string;
  namespaceSlug: string;
  status: string;
  likeCount: number;
  solutionCount: number;
}

const INTERACTIVE = "a, button, input, select, textarea, label, [role='dialog'], [tabindex]";

export function ChallengesList({ challenges }: { challenges: ChallengeRowData[] }) {
  const router = useRouter();
  const onRowClick = (e: MouseEvent<HTMLDivElement>, href: string) => {
    const target = e.target instanceof Element ? e.target : null;
    const go = shouldRowNavigate({
      onInteractive: !!target?.closest(INTERACTIVE),
      selectionText: window.getSelection()?.toString() ?? "",
      button: e.button,
      modifier: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
    });
    if (go) router.push(href);
  };

  return (
    <div className="rows ch-rows reveal">
      <div className="row row-head ch-row">
        <span className="ch-c-num">Number</span>
        <span className="ch-c-title">Title</span>
        <span className="ch-c-status">Status</span>
        <span className="ch-c-ns">Namespace</span>
        <span className="ch-c-author">Author</span>
        <span className="ch-c-likes">Likes</span>
        <span className="ch-c-sol">Solutions</span>
        <span className="ch-c-date">Date</span>
      </div>
      {challenges.map((c) => (
        <ChallengeRow key={c.id} challenge={c} onClick={onRowClick} />
      ))}
    </div>
  );
}

function ChallengeRow({
  challenge,
  onClick,
}: {
  challenge: ChallengeRowData;
  onClick: (e: MouseEvent<HTMLDivElement>, href: string) => void;
}) {
  const fmt = useDateFmt();
  const href = challengeHref(challenge.number);
  return (
    <div
      className={challenge.isNew ? "row row-link ch-row has-new" : "row row-link ch-row"}
     
      data-number={challenge.number}
      onClick={(e) => onClick(e, href)}
    >
      <span className="ch-c-num mono">
        {challenge.number}
      </span>
      <span className="ch-c-title">
        <Link href={href} className="ttl ch-title-link" title={challenge.title}>
          {challenge.title}
        </Link>
        <ChallengeStateBadges challenge={challenge} />
      </span>
      <span className="ch-c-status">
        <span className={statusPillClass(challenge.status)}>{CHALLENGE_STATUS_LABEL[challenge.status] ?? challenge.status}</span>
      </span>
      <span className="ch-c-ns ns">
        /{challenge.namespaceSlug}
      </span>
      <span className="ch-c-author">
        <AvatarBubble size="sm" userId={challenge.author.userId} displayName={challenge.author.displayName} anonymous={challenge.author.anonymous} deactivated={challenge.author.active === false} />
        <span className="ch-author-name">
          <ChallengeAuthorName challenge={challenge} />
        </span>
      </span>
      <span className="ch-c-likes" title={`${challenge.likeCount} likes`}>
        ❤ {challenge.likeCount}
      </span>
      <span className="ch-c-sol">
        <span className="ch-sol-n">{challenge.solutionCount}</span>
        <span className="ch-sol-label">{solutionCountLabel(challenge.solutionCount)}</span>
      </span>
      <span className="ch-c-date mono">
        {fmt.date(challenge.createdAt)}
      </span>
      <ChallengeNewTag challenge={challenge} />
    </div>
  );
}

/** The Cards | List segmented control (the `.sort-toggle` look, each option aria-pressed). */
export function ChallengesViewToggle({ view, onChange }: { view: ChallengesView; onChange: (v: ChallengesView) => void }) {
  const opts: { key: ChallengesView; label: string }[] = [
    { key: "cards", label: "Cards" },
    { key: "list", label: "List" },
  ];
  return (
    <div className="sort-toggle ch-view-toggle" role="group" aria-label="Gallery view">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          className={view === o.key ? "sort-opt sort-on" : "sort-opt"}
          aria-pressed={view === o.key}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
