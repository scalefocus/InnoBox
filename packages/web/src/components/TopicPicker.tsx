"use client";
// The topic picker (INNOBOX_SPEC.md §34.3): the submit form, the author's edit form and the
// admin's Edit topics control. A tag field with the look of the §4.3 access-list editor: focusing
// it lists the active topics alphabetically, typing narrows the list (a case-insensitive substring
// of the name), picking adds a tag; each tag has a ✕, and Backspace in an empty field removes the
// last. No free text — only listed topics can be picked. At three tags the list closes and the
// field reads "Up to 3 topics". A retired topic already on the challenge shows as a muted tag that
// can be removed but not added back (it is not in the list). The server re-checks every rule.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { TOPICS_PER_CHALLENGE_MAX, sortTopicNames } from "@innobox/shared/topics";
import { FloatingResults } from "@/components/FloatingResults";
import { cachedGet } from "@/lib/ui";

/** A topic as a challenge payload carries it. */
export interface TopicTag {
  id: string;
  name: string;
  active: boolean;
}

/** An active topic the picker can offer. */
export interface TopicOption {
  id: string;
  name: string;
  description: string | null;
}

/** The active topics, alphabetical (the shared GET cache — the list rarely changes in a visit). */
export function useActiveTopics(): TopicOption[] | null {
  const [topics, setTopics] = useState<TopicOption[] | null>(null);
  useEffect(() => {
    let live = true;
    cachedGet<{ topics: TopicOption[] }>("/api/topics")
      .then((j) => {
        if (live) setTopics(j.topics);
      })
      .catch(() => {
        if (live) setTopics([]);
      });
    return () => {
      live = false;
    };
  }, []);
  return topics;
}

export function TopicPicker({
  id,
  value,
  onChange,
  options,
  disabled = false,
}: {
  id: string;
  value: TopicTag[];
  onChange: (next: TopicTag[]) => void;
  /** The active topics; null while loading. */
  options: TopicOption[] | null;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const full = value.length >= TOPICS_PER_CHALLENGE_MAX;

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    const byName = new Map((options ?? []).map((o) => [o.name, o]));
    return sortTopicNames([...byName.keys()])
      .map((name) => byName.get(name)!)
      .filter((o) => !value.some((t) => t.id === o.id) && (q === "" || o.name.toLowerCase().includes(q)));
  }, [options, text, value]);

  const showList = open && !full && !disabled && matches.length > 0;

  const add = (option: TopicOption) => {
    if (full || value.some((t) => t.id === option.id)) return;
    const next = [...value, { id: option.id, name: option.name, active: true }];
    onChange(next);
    setText("");
    setHighlight(0);
    if (next.length >= TOPICS_PER_CHALLENGE_MAX) setOpen(false);
    inputRef.current?.focus();
  };

  const remove = (tag: TopicTag) => {
    onChange(value.filter((t) => t.id !== tag.id));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(0, matches.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      // Never submits the surrounding form: Enter picks the highlighted topic, or nothing.
      e.preventDefault();
      const pick = showList ? matches[Math.min(highlight, matches.length - 1)] : undefined;
      if (pick) add(pick);
    } else if (e.key === "Backspace" && text === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div>
      <div className="tag-field topic-picker" onClick={() => inputRef.current?.focus()}>
        {value.length > 0 && (
          <ul className="tag-list" aria-label="Topics added">
            {value.map((tag) => (
              <li key={tag.id} className={`tag${tag.active ? "" : " is-pending topic-tag-retired"}`} title={tag.active ? tag.name : "Retired topic"}>
                <span className="tag-label">{tag.name}</span>
                <button type="button" className="tag-remove" aria-label={`Remove ${tag.name}`} disabled={disabled} onClick={() => remove(tag)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          id={id}
          ref={inputRef}
          className="tag-input"
          type="text"
          autoComplete="off"
          role="combobox"
          aria-controls={`${id}-listbox`}
          aria-expanded={showList}
          aria-autocomplete="list"
          disabled={disabled}
          readOnly={full}
          value={full ? "" : text}
          placeholder={full ? `Up to ${TOPICS_PER_CHALLENGE_MAX} topics` : value.length === 0 ? "Pick topics…" : undefined}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setHighlight(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {showList && (
        <FloatingResults anchorRef={inputRef} onClose={() => setOpen(false)}>
          <div id={`${id}-listbox`} role="listbox" aria-label="Topics" className="topic-options">
            {matches.map((o, i) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={`user-result-item topic-option${i === highlight ? " is-active" : ""}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => add(o)}
              >
                <span className="user-result-text">
                  <span className="user-result-name" title={o.name}>
                    {o.name}
                  </span>
                  {o.description && (
                    <span className="user-result-mail" title={o.description}>
                      {o.description}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </FloatingResults>
      )}
    </div>
  );
}
