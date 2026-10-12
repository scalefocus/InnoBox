"use client";
// The shared 1–5 star control (INNOBOX_SPEC.md §13.10), on the §2.2 tokens: `--accent` for set
// stars, `--faint` at rest, a hover preview — no new token. Nothing is saved on click; it is local
// form state. Clicking the selected star again CLEARS the question, so every question stays
// optional.
//
// Keyboard: a `radiogroup` labelled by the question, five `radio` stars with a roving tabindex;
// arrows move AND select, Space/Enter selects the focused star. A visually hidden "Not answered"
// is announced when a question is cleared.
import { useRef, useState, type KeyboardEvent } from "react";

export function StarInput({
  labelledBy,
  value,
  onChange,
  disabled = false,
}: {
  labelledBy: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [cleared, setCleared] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // The tab stop: the selected star, else the first.
  const focusIndex = value ? value - 1 : 0;

  const select = (stars: number) => {
    if (disabled) return;
    if (stars === value) {
      onChange(null);
      setCleared(true);
    } else {
      onChange(stars);
      setCleared(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(4, index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 4;
    if (next !== null) {
      event.preventDefault();
      onChange(next + 1);
      setCleared(false);
      refs.current[next]?.focus();
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      select(index + 1);
    }
  };

  const shown = hover ?? value ?? 0;
  return (
    <div className="star-input" role="radiogroup" aria-labelledby={labelledBy} onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((stars, index) => (
        <button
          key={stars}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === stars}
          aria-label={`${stars} star${stars === 1 ? "" : "s"}`}
          tabIndex={index === focusIndex ? 0 : -1}
          className={stars <= shown ? "star is-set" : "star"}
          data-preview={hover !== null ? "true" : undefined}
          disabled={disabled}
          onMouseEnter={() => setHover(stars)}
          onClick={() => select(stars)}
          onKeyDown={(e) => onKeyDown(e, index)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3.2l2.6 5.5 6 .8-4.4 4.1 1.1 5.9L12 16.6l-5.3 2.9 1.1-5.9-4.4-4.1 6-.8L12 3.2z" />
          </svg>
        </button>
      ))}
      <span className="sr-only" aria-live="polite">
        {cleared && value === null ? "Not answered" : ""}
      </span>
    </div>
  );
}
