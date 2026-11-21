import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SIDEBAR_LABEL_MAX_CHARS } from "@opengeni/contracts/sidebar-layout";
import { TextInput } from "@opengeni/react/ui/field";

/** A group's name, edited in place: Enter or leaving the field saves, Escape cancels. */
export function RenameField({
  label,
  onSave,
  onDone,
}: {
  label: string;
  onSave: (label: string) => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(label);
  const input = useRef<HTMLInputElement>(null);
  // The menu that opened it hands focus back to its button as it closes;
  // take it after that.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  // Enter saves and closes the field; the blur that may follow must not save again.
  const finished = useRef(false);
  const finish = (next: string | null) => {
    if (finished.current) return;
    finished.current = true;
    if (next && next !== label) onSave(next);
    onDone();
  };
  const save = () => finish(value.trim());
  return (
    <TextInput
      ref={input}
      aria-label="Group name"
      value={value}
      maxLength={SIDEBAR_LABEL_MAX_CHARS}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      }}
      className="h-8"
    />
  );
}
