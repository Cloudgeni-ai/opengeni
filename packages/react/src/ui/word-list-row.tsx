import { useEffect, useRef, useState } from "react";
import { SettingRow } from "./setting-row";
import { Textarea } from "./textarea";

/** A transcription request takes at most this many words to listen for, each this long. */
export const WORD_LIST_MAX = 100;
export const WORD_LIST_TERM_MAX = 50;

/**
 * Names and words a transcription listens for, typed one per line. The list
 * saves when the field loses focus, and only when every word fits.
 */
export function WordListRow({
  words,
  saving,
  disabled,
  disabledReason,
  text,
  onChange,
}: {
  words: readonly string[];
  saving: boolean;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  text: {
    label: string;
    description: string;
    placeholder: string;
    termTooLong: (term: string, max: number) => string;
    tooMany: (max: number) => string;
  };
  onChange: (words: string[]) => void;
}) {
  const saved = words.join("\n");
  const [draft, setDraft] = useState(saved);
  const editing = useRef(false);
  // The saved list wins while the person isn't typing in it.
  useEffect(() => {
    if (!editing.current) setDraft(saved);
  }, [saved]);
  const terms = wordListTerms(draft);
  const tooLong = terms.find((term) => term.length > WORD_LIST_TERM_MAX);
  const tooMany = terms.length > WORD_LIST_MAX;
  return (
    <SettingRow
      variant="stacked"
      label={text.label}
      description={disabledReason ?? text.description}
      error={
        tooLong
          ? text.termTooLong(tooLong.slice(0, 20), WORD_LIST_TERM_MAX)
          : tooMany
            ? text.tooMany(WORD_LIST_MAX)
            : null
      }
      control={
        <Textarea
          rows={3}
          value={draft}
          disabled={disabled || (saving && !editing.current)}
          placeholder={text.placeholder}
          aria-label={text.label}
          aria-invalid={tooLong || tooMany ? true : undefined}
          onFocus={() => {
            editing.current = true;
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            editing.current = false;
            if (tooLong || tooMany) return;
            if (terms.join("\n") !== saved) onChange(terms);
            else setDraft(saved);
          }}
        />
      }
    />
  );
}

/** The terms in what the person typed: one per line or between commas, without repeats. */
export function wordListTerms(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of text.split(/[\n,;]/u)) {
    const term = part.trim().replace(/\s+/gu, " ");
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}
