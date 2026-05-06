import { ArrowUpIcon, CommandIcon } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface ComposerHandle {
  focus: () => void;
  clear: () => void;
}

interface ComposerProps {
  placeholder?: string;
  submitLabel?: string;
  disabled?: boolean;
  disabledHint?: string;
  pending?: boolean;
  autoFocus?: boolean;
  examples?: ReadonlyArray<string>;
  controlsBeforeSubmit?: ReactNode;
  onSubmit: (prompt: string) => void;
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform ?? "");
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    placeholder = "Ask the agent to...",
    submitLabel = "Send",
    disabled = false,
    disabledHint,
    pending = false,
    autoFocus = false,
    examples,
    controlsBeforeSubmit,
    onSubmit,
  },
  handleRef,
) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useImperativeHandle(handleRef, () => ({
    focus: () => textareaRef.current?.focus(),
    clear: () => setValue(""),
  }));

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !disabled && !pending;

  function submit() {
    if (!canSubmit) return;
    onSubmit(trimmed);
    setValue("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape" && value.length > 0) {
      event.preventDefault();
      setValue("");
    }
  }

  return (
    <div className="w-full">
      <div
        className={cn(
          "group relative rounded-xl border bg-[color:var(--color-surface)]",
          "border-[color:var(--color-border)] transition-colors",
          "focus-within:border-[color:var(--color-border-strong)]",
          disabled && "opacity-70",
        )}
      >
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          rows={2}
          aria-label="Prompt"
          className={cn(
            "min-h-[64px] max-h-[220px] resize-none border-0 bg-transparent",
            "px-4 pt-3 pb-12 text-[15px] leading-relaxed shadow-none",
            "focus-visible:border-0 focus-visible:ring-0",
            "placeholder:text-[color:var(--color-fg-subtle)]",
          )}
        />
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-between">
          <span className="pointer-events-auto flex items-center gap-1 pl-2 text-[11px] text-[color:var(--color-fg-subtle)]">
            {disabled && disabledHint ? (
              <span>{disabledHint}</span>
            ) : (
              <>
                <kbd className="inline-flex items-center gap-0.5 rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)] px-1 py-0.5 font-mono">
                  {isMac() ? <CommandIcon className="size-2.5" /> : "Ctrl"}
                  <span className="text-[11px]">Enter</span>
                </kbd>
                <span>to send</span>
              </>
            )}
          </span>
          <div className="pointer-events-auto flex items-center gap-1.5">
            {controlsBeforeSubmit}
            <Button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              aria-label={submitLabel}
              size="sm"
              className={cn(
                "h-8 gap-1.5 rounded-md px-3",
                "bg-[color:var(--color-brand-strong)] text-[color:var(--color-brand-fg)]",
                "hover:bg-[color:var(--color-brand)]",
              )}
            >
              <ArrowUpIcon className="size-3.5" />
              <span className="text-xs font-medium">{submitLabel}</span>
            </Button>
          </div>
        </div>
      </div>
      {examples && examples.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setValue(example);
                textareaRef.current?.focus();
              }}
              disabled={disabled || pending}
              className={cn(
                "max-w-full truncate rounded-full border px-3 py-1 text-left text-xs",
                "border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/60",
                "text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]",
                "hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-surface-2)]",
                "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
