"use client";
// Topics (INNOBOX_SPEC.md §34.6): every active topic, alphabetical — its name (a link to the
// gallery filtered by it), its description, how many open challenges in it the viewer can see, and
// a Follow button. Following a topic tells you when a new challenge in it opens for solutions
// (§34.5). The counts are the viewer's own (invariant 2): the API computes them per viewer.
import Link from "next/link";
import { useEffect, useState } from "react";
import { cachedGet } from "@/lib/ui";
import { TopicFollowButton } from "@/components/TopicFollowButton";

interface TopicItem {
  id: string;
  name: string;
  description: string | null;
  following: boolean;
  openCount: number;
}

export default function TopicsPage() {
  const [topics, setTopics] = useState<TopicItem[] | null>(null);
  // §34.6: the empty state points a platform admin to where topics are added.
  const [platformAdmin, setPlatformAdmin] = useState(false);

  useEffect(() => {
    fetch("/api/topics", { headers: { accept: "application/json" } })
      .then((res) => res.json())
      .then((json) => setTopics(Array.isArray(json.topics) ? json.topics : []))
      .catch(() => setTopics([]));
    cachedGet<{ roles: { platformAdmin: boolean } }>("/api/me")
      .then((me) => setPlatformAdmin(me.roles.platformAdmin === true))
      .catch(() => {});
  }, []);

  const setFollowing = (id: string, following: boolean) =>
    setTopics((cur) => cur?.map((t) => (t.id === id ? { ...t, following } : t)) ?? cur);

  return (
    <>
      <div className="page-head reveal">
        <div className="eyebrow">Discover</div>
        <h1 className="page-title">Topics</h1>
        <p className="page-sub">Follow a topic to hear when a new challenge in it opens for solutions.</p>
      </div>

      {topics === null && <p className="muted">Loading…</p>}
      {topics !== null && topics.length === 0 && (
        <div className="card card-pad empty reveal">
          <div className="ico">🏷️</div>
          <p className="muted" style={{ margin: 0 }}>
            No topics yet.
          </p>
          {platformAdmin && (
            <p style={{ margin: "8px 0 0" }}>
              <Link href="/admin/settings">Add topics in Platform settings</Link>
            </p>
          )}
        </div>
      )}
      {topics !== null && topics.length > 0 && (
        <div className="rows" data-testid="topics-list">
          {topics.map((topic) => (
            <div className="row topic-row" key={topic.id} data-testid="topic-row">
              <div className="grow">
                <Link className="ttl" href={`/challenges?topic=${topic.id}`}>
                  {topic.name}
                </Link>
                {topic.description && <div className="sub">{topic.description}</div>}
              </div>
              <span className="sub mono topic-open">{topic.openCount} open</span>
              <TopicFollowButton topicId={topic.id} following={topic.following} onChange={(following) => setFollowing(topic.id, following)} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
