import { ArrowUp, Lock, Menu, Users } from "lucide-react";
import { useEffect, useRef } from "react";

export type Draft = {
  shared: boolean;
  text: string;
  /** Set while the agent is being made from the first message. */
  sending: string | null;
  error: string | null;
  requestId: string;
};

export function newDraft(): Draft {
  return { shared: false, text: "", sending: null, error: null, requestId: crypto.randomUUID() };
}

const SUGGESTIONS = [
  "A research assistant that digs into topics for me",
  "A writing partner for emails and posts",
  "A helper for one of my GitHub repos",
];

/**
 * A new agent before it exists: nothing is made until the first message, so
 * the button opens instantly and pressing it again never piles up empty agents.
 */
export function DraftAgentView({
  draft,
  workspaceName,
  onChange,
  onSend,
  onOpenSidebar,
}: {
  draft: Draft;
  workspaceName: string | null;
  onChange: (draft: Draft) => void;
  onSend: (text: string) => void;
  onOpenSidebar: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = draft.sending !== null;
  useEffect(() => {
    if (!busy) input.current?.focus();
  }, [busy]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [draft.text]);
  const submit = (text: string) => {
    if (!text.trim() || busy) return;
    onSend(text.trim());
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--app-border)] px-3 py-2.5 md:px-5">
        <button
          type="button"
          onClick={onOpenSidebar}
          className="rounded-lg p-1.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)] md:hidden"
          aria-label="Open agents"
        >
          <Menu size={18} />
        </button>
        <DraftAvatar size={36} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold">New agent</h1>
          <p className="truncate text-xs text-[var(--app-muted)]">
            {draft.shared ? "Shared with your workspace" : "Only for you"}
          </p>
        </div>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {busy ? (
          <div className="mx-auto w-full max-w-3xl px-6 pt-8">
            <div className="ml-auto w-fit max-w-[80%] rounded-3xl bg-[var(--app-hover)] px-4 py-2.5 text-[15px] whitespace-pre-wrap">
              {draft.sending}
            </div>
            <div className="flex items-center gap-2.5 pt-5 text-sm text-[var(--app-muted)]">
              <span className="working-dots" aria-label="Setting up">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        ) : (
          <div className="card-in mx-auto flex max-w-xl flex-col items-center px-6 pt-[10vh] text-center">
            <DraftAvatar size={88} />
            <h2 className="mt-4 text-xl font-semibold tracking-tight">
              What should this agent do?
            </h2>
            <p className="mt-1 text-sm text-[var(--app-muted)]">
              Describe it in your own words. It takes shape as you talk.
            </p>
            <div
              role="radiogroup"
              aria-label="Who can use this agent"
              className="mt-6 grid w-full max-w-sm grid-cols-2 gap-1 rounded-2xl border border-[var(--app-border)] bg-[var(--app-sidebar)] p-1"
            >
              <Choice
                active={!draft.shared}
                icon={<Lock size={14} />}
                label="Personal"
                hint="Only you"
                onClick={() => onChange({ ...draft, shared: false })}
              />
              <Choice
                active={draft.shared}
                icon={<Users size={14} />}
                label="Workspace"
                hint={workspaceName ? `Everyone in ${workspaceName}` : "Your whole team"}
                onClick={() => onChange({ ...draft, shared: true })}
              />
            </div>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((text) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => submit(text)}
                  className="rounded-full border border-[var(--app-border)] bg-[var(--app-card)] px-3.5 py-2 text-sm hover:border-[var(--app-accent)]"
                >
                  {text}
                </button>
              ))}
            </div>
            {draft.error ? (
              <p className="mt-5 text-sm text-red-600 dark:text-red-400">{draft.error}</p>
            ) : null}
          </div>
        )}
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4 md:px-6">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(draft.text);
          }}
          className="flex items-end gap-2 rounded-3xl border border-[var(--app-border)] bg-[var(--app-card)] p-2 pl-4 shadow-[0_1px_3px_rgba(0,0,0,0.05)] focus-within:border-[var(--app-accent)]"
        >
          <textarea
            ref={input}
            rows={1}
            value={draft.text}
            disabled={busy}
            placeholder="Tell your new agent what it's for"
            onChange={(event) => onChange({ ...draft, text: event.target.value, error: null })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit(draft.text);
              }
            }}
            className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent py-1.5 text-[15px] outline-none placeholder:text-[var(--app-muted)] disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !draft.text.trim()}
            aria-label="Send"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--app-accent)] text-white transition-opacity disabled:opacity-30"
          >
            <ArrowUp size={18} />
          </button>
        </form>
      </div>
    </div>
  );
}

function Choice({
  active,
  icon,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`flex min-w-0 flex-col items-center rounded-xl px-3 py-2 transition-colors ${
        active
          ? "bg-[var(--app-card)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
          : "text-[var(--app-muted)] hover:text-[var(--app-fg)]"
      }`}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium">
        {icon}
        {label}
      </span>
      <span className="max-w-full truncate text-[11px] text-[var(--app-muted)]">{hint}</span>
    </button>
  );
}

export function DraftAvatar({ size }: { size: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full border-2 border-dashed border-[var(--app-border)] text-[var(--app-muted)]"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      +
    </div>
  );
}
