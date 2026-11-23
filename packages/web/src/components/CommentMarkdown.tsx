"use client";
// A comment as the thread shows it (INNOBOX_SPEC.md §44.3, §44.4, §44.7): its display text parsed by
// the one parser in `@innobox/shared/comment-markdown`, and one element built per node of that tree —
// a paragraph, a list, a quote, a code block, bold, italic, strikethrough, inline code, a link, a
// mention, a line break. Nothing a person types becomes markup: no HTML string is produced or
// inserted here, so there is nothing to sanitize and no element outside §44.3's table can appear.
// The comment box's Preview tab renders through this same component, so a preview is the thread.
//
// A link opens in a new tab with no opener and no referrer (§44.4). A mention is the person's name
// as a link that opens the §13.8 directory card — muted for a deactivated person, muted plain text
// for an erased one (§43.7). A removed comment never reaches this component (§44.7).
import { useMemo, type ReactNode } from "react";
import { COMMENT_LINK_REL, COMMENT_LINK_TARGET, parseCommentMarkdown, type CommentBlock, type CommentInline } from "@innobox/shared/comment-markdown";
import { MentionLink } from "./Mentions";

/** Where a mention sits in a comment's display text, and whom it names (§44.10). */
export interface CommentMentionView {
  start: number;
  length: number;
  /** Null for an erased person: plain "@Deleted User", no link and no card. */
  user: { id: string; displayName: string; active: boolean } | null;
}

function inline(nodes: readonly CommentInline[], mentions: readonly CommentMentionView[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return node.value;
      case "break":
        return <br key={i} />;
      case "strong":
        return <strong key={i}>{inline(node.children, mentions)}</strong>;
      case "emphasis":
        return <em key={i}>{inline(node.children, mentions)}</em>;
      case "strike":
        return <del key={i}>{inline(node.children, mentions)}</del>;
      case "code":
        return <code key={i}>{node.value}</code>;
      case "link":
        // §44.4: always a new tab — a link to this app included — so the reader keeps their place.
        return (
          <a key={i} className="comment-link" href={node.href} target={COMMENT_LINK_TARGET} rel={COMMENT_LINK_REL}>
            {inline(node.children, mentions)}
          </a>
        );
      case "mention": {
        const mention = mentions[node.index];
        if (!mention) return node.text; // a range the payload does not carry — never expected
        return mention.user ? (
          <MentionLink key={i} user={mention.user} label={node.text} />
        ) : (
          <span key={i} className="mention mention-deleted">
            {node.text}
          </span>
        );
      }
    }
  });
}

function blocks(nodes: readonly CommentBlock[], mentions: readonly CommentMentionView[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "paragraph":
        return <p key={i}>{inline(node.children, mentions)}</p>;
      case "codeBlock":
        // Its spaces and line breaks kept; scrolls sideways inside the comment (§44.3, globals.css).
        return (
          <pre key={i}>
            <code>{node.value}</code>
          </pre>
        );
      case "list": {
        const items = node.items.map((item, n) => <li key={n}>{blocks(item, mentions)}</li>);
        return node.ordered ? (
          <ol key={i} start={node.start ?? undefined}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
      case "quote":
        return <blockquote key={i}>{blocks(node.children, mentions)}</blockquote>;
    }
  });
}

/**
 * §44.7: `body` is a comment's display text and `mentions` the ranges of it that are mentions, as
 * `GET /api/comments` reports them — or, in the Preview tab, as binding finds them (§44.2).
 */
export function CommentMarkdown({ body, mentions }: { body: string; mentions?: readonly CommentMentionView[] }) {
  const tree = useMemo(() => parseCommentMarkdown(body, mentions ?? []), [body, mentions]);
  return <div className="comment-md">{blocks(tree, mentions ?? [])}</div>;
}
