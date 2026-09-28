import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { CircleAlertIcon, XIcon } from "lucide-react";

import { useFieldControlProps } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   EmailChipsInput - several email addresses in one field (Invite people).
   -------------------------------------------------------------------------- */

export interface EmailChip {
  value: string;
  problem?: string;
}

/**
 * Several email addresses as chips, inside a Field. Enter, comma, space and
 * paste make chips; Backspace on an empty field removes the last one. A chip
 * with a `problem` shows in danger with the problem read to screen readers.
 */
export function EmailChipsInput({
  chips,
  onChange,
  placeholder,
}: {
  chips: EmailChip[];
  onChange: (values: string[]) => void;
  placeholder: string;
}) {
  const field = useFieldControlProps();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const listId = useId();

  const commit = (text: string) => {
    const parts = text
      .split(/[\s,;]+/)
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return;
    const values = chips.map((chip) => chip.value);
    onChange([...values, ...parts.filter((part) => !values.includes(part))]);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === "Enter" || event.key === "," || event.key === " ") && draft.trim()) {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && !draft && chips.length > 0) {
      onChange(chips.slice(0, -1).map((chip) => chip.value));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (/[\s,;]/.test(text)) {
      event.preventDefault();
      commit(text);
    }
  };

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className={cn(
        "flex min-h-9 w-full min-w-0 cursor-text flex-wrap items-center gap-1.5 rounded-md border bg-surface px-2 py-1.5 transition-colors duration-[120ms] hover:border-border-strong pointer-coarse:min-h-11",
        "has-[input:focus-visible]:border-brand has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-brand/55",
        field["aria-invalid"] ? "border-danger hover:border-danger" : "border-border",
      )}
    >
      {chips.length > 0 ? (
        <ul id={listId} aria-label="Addresses" className="contents">
          {chips.map((chip) => (
            <li
              key={chip.value}
              className={cn(
                "inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-full border pr-0.5 pl-2 text-xs font-medium",
                chip.problem
                  ? "border-danger/50 bg-danger/5 text-danger"
                  : "border-border bg-surface-2 text-fg",
              )}
            >
              {chip.problem ? (
                <CircleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
              ) : null}
              <span className="min-w-0 truncate">{chip.value}</span>
              {chip.problem ? <span className="sr-only">: {chip.problem}</span> : null}
              <button
                type="button"
                aria-label={`Remove ${chip.value}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onChange(chips.filter((each) => each !== chip).map((each) => each.value));
                  inputRef.current?.focus();
                }}
                className="grid size-5 shrink-0 place-items-center rounded-full text-current opacity-70 transition-opacity hover:opacity-100 pointer-coarse:size-8"
              >
                <XIcon aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={inputRef}
        {...field}
        type="email"
        inputMode="email"
        autoComplete="off"
        value={draft}
        placeholder={chips.length === 0 ? placeholder : undefined}
        aria-describedby={
          [field["aria-describedby"], chips.length > 0 ? listId : null].filter(Boolean).join(" ") ||
          undefined
        }
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => commit(draft)}
        className="h-6 min-w-40 flex-1 border-0 bg-transparent px-1 text-sm text-fg outline-none! placeholder:text-fg-subtle pointer-coarse:text-base"
      />
    </div>
  );
}
