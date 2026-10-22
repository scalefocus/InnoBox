"use client";
// A challenge's topics as small chips (INNOBOX_SPEC.md §34.6): on the gallery cards and the detail
// page, each leading to the gallery filtered by that topic (`/challenges?topic=<id>`). A retired
// topic stays on the challenge as history, muted, and still filters. Inside a card — which is
// itself a link — a nested anchor is invalid HTML, so there the chips are link-role spans that
// navigate on their own and keep the click from opening the card.
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { KeyboardEvent, MouseEvent } from "react";

export interface TopicChipData {
  id: string;
  name: string;
  active: boolean;
}

export function topicFilterHref(topicId: string): string {
  return `/challenges?topic=${encodeURIComponent(topicId)}`;
}

export function TopicChips({ topics, insideLink = false }: { topics: readonly TopicChipData[]; insideLink?: boolean }) {
  const router = useRouter();
  if (topics.length === 0) return null;

  const go = (e: MouseEvent | KeyboardEvent, href: string) => {
    e.preventDefault();
    e.stopPropagation();
    router.push(href);
  };

  return (
    <>
      {topics.map((t) => {
        const href = topicFilterHref(t.id);
        const className = t.active ? "chip topic-chip" : "chip topic-chip is-retired";
        const title = t.active ? `Challenges in ${t.name}` : "Retired topic";
        if (!insideLink) {
          return (
            <Link key={t.id} href={href} className={className} title={title}>
              {t.name}
            </Link>
          );
        }
        return (
          <span
            key={t.id}
            role="link"
            tabIndex={0}
            className={className}
            title={title}
            onClick={(e) => go(e, href)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(e, href);
            }}
          >
            {t.name}
          </span>
        );
      })}
    </>
  );
}
