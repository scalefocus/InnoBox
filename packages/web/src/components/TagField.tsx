"use client";
// A free-text tag field (INNOBOX_SPEC.md §24.3): the /submit form's *Their work e-mails* and *Team
// names*. Typing and pressing Enter or comma locks the text in as a tag when it passes the field's
// rule; otherwise it stays in the field with the inline error. Pasting splits a list — valid parts
// become tags, the rest stay in the field, flagged. Each tag has a ✕, and Backspace in an empty
// field removes the last one. The tags are a list announced to assistive tech.
//
// The form calls `ref.current.finish()` on Submit: valid text still in the field is locked in, and
// invalid text — or no tags at all — blocks with the error and moves focus to the field. The rules
// themselves live in @innobox/shared/challenge-access, so the browser and the API always agree.
import { useImperativeHandle, useRef, useState, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import {
  EMAILS_REQUIRED,
  TEAMS_REQUIRED,
  applyPaste,
  checkEmailTag,
  checkTeamTag,
} from "@innobox/shared/challenge-access";

export interface TagFieldHandle {
  /** Locks in valid pending text; false (with the error shown and focus moved) when the field
   *  still holds invalid text or has no tags. Returns the tags as they stand after the commit. */
  finish(): { ok: true; values: string[] } | { ok: false };
}

export function TagField({
  id,
  kind,
  values,
  onChange,
  max,
  placeholder,
  ref,
}: {
  id: string;
  kind: "email" | "team";
  values: string[];
  onChange: (values: string[]) => void;
  max: number;
  placeholder?: string;
  ref?: Ref<TagFieldHandle>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = `${id}-error`;

  const check = (raw: string, existing: readonly string[]) => (kind === "email" ? checkEmailTag(raw, existing) : checkTeamTag(raw, existing));

  /** Lock the current text in; null on success, else the error. */
  const commit = (raw: string): { values: string[]; error: string | null } => {
    if (raw.trim() === "") return { values, error: null };
    if (values.length >= max) return { values, error: `At most ${max} can be added.` };
    const result = check(raw, values);
    if (!result.ok) return { values, error: result.error };
    return { values: [...values, result.value], error: null };
  };

  useImperativeHandle(ref, () => ({
    finish() {
      const result = commit(text);
      if (result.error) {
        setError(result.error);
        inputRef.current?.focus();
        return { ok: false };
      }
      if (result.values !== values) {
        onChange(result.values);
        setText("");
      }
      if (result.values.length === 0) {
        setError(kind === "email" ? EMAILS_REQUIRED : TEAMS_REQUIRED);
        inputRef.current?.focus();
        return { ok: false };
      }
      setError(null);
      return { ok: true, values: result.values };
    },
  }));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (text.trim() === "") return;
      const result = commit(text);
      setError(result.error);
      if (!result.error) {
        onChange(result.values);
        setText("");
      }
    } else if (e.key === "Backspace" && text === "" && values.length > 0) {
      onChange(values.slice(0, -1));
      setError(null);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!/[,;\n]/.test(pasted) && !(kind === "email" && /\s/.test(pasted.trim()))) return; // a single value: type it in as usual
    e.preventDefault();
    const outcome = applyPaste(kind, `${text} ${pasted}`, values, max);
    if (outcome.added.length > 0) onChange([...values, ...outcome.added]);
    setText(outcome.rest);
    setError(outcome.error);
  };

  const remove = (value: string) => {
    onChange(values.filter((v) => v !== value));
    inputRef.current?.focus();
  };

  return (
    <div>
      <div className={`tag-field${error ? " has-error" : ""}`} onClick={() => inputRef.current?.focus()}>
        {values.length > 0 && (
          <ul className="tag-list" aria-label={kind === "email" ? "E-mail addresses added" : "Teams added"}>
            {values.map((value) => (
              <li key={value} className="tag">
                <span className="tag-label" title={value}>
                  {value}
                </span>
                <button type="button" className="tag-remove" aria-label={`Remove ${value}`} onClick={() => remove(value)}>
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
          // Plain text, not type="email": the browser's own validation would block Submit before the
          // field's rule could lock valid text in or explain what is wrong.
          type="text"
          inputMode={kind === "email" ? "email" : undefined}
          autoComplete="off"
          value={text}
          placeholder={values.length === 0 ? placeholder : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      </div>
      {error && (
        <div id={errorId} className="tag-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
