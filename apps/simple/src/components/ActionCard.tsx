import { ArrowRight, Check, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { appApi, type AppliedBlock } from "../lib/app-api";
import { blockKey, type ActionBlock } from "../lib/blocks";
import { useAppEvents } from "../lib/app-events";

/** Blocks written in the last few minutes apply on their own; older ones wait for a click. */
const AUTO_APPLY_WINDOW_MS = 10 * 60 * 1000;

type State =
  | { phase: "checking" }
  | { phase: "ready" }
  | { phase: "applying" }
  | { phase: "done"; result: AppliedBlock }
  | { phase: "error"; message: string };

export function ActionCard({
  block,
  workspaceId,
  sourceSessionId,
  occurredAt,
  onOpenAgent,
}: {
  block: ActionBlock;
  workspaceId: string;
  sourceSessionId: string;
  occurredAt: string;
  onOpenAgent: (sessionId: string) => void;
}) {
  const [state, setState] = useState<State>({ phase: "checking" });
  const keyRef = useRef<string | null>(null);
  const events = useAppEvents();

  const apply = async () => {
    if (!block.payload || !keyRef.current) return;
    setState({ phase: "applying" });
    try {
      const result = await appApi.applyBlock({
        workspaceId,
        key: keyRef.current,
        kind: block.kind,
        sourceSessionId,
        payload: block.payload,
      });
      if (result?.state === "applied") {
        setState({ phase: "done", result });
        events.changed();
      } else if (result?.state === "applying") {
        // Another tab is applying it; look again shortly.
        setTimeout(() => void check(false), 1500);
      } else setState({ phase: "error", message: "That didn't work." });
    } catch (error) {
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const check = async (autoApply: boolean) => {
    if (!block.complete || !block.payload) return;
    keyRef.current ??= await blockKey(sourceSessionId, block);
    const existing = await appApi.getBlock(keyRef.current).catch(() => null);
    if (existing?.state === "applied") setState({ phase: "done", result: existing });
    else if (existing?.state === "applying") setTimeout(() => void check(false), 1500);
    else if (autoApply && Date.now() - Date.parse(occurredAt) < AUTO_APPLY_WINDOW_MS) await apply();
    else setState({ phase: "ready" });
  };

  useEffect(() => {
    void check(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one check per complete block
  }, [block.complete, block.raw, sourceSessionId]);

  const payload = block.payload ?? {};
  const name = typeof payload.name === "string" ? payload.name : null;
  const emoji =
    typeof payload.emoji === "string" ? payload.emoji : block.kind === "agent" ? "🤖" : "✨";
  const description = typeof payload.description === "string" ? payload.description : null;

  if (!block.complete) {
    return (
      <div className="card-in my-2 flex items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] px-3 py-2.5 text-sm text-[var(--app-muted)]">
        <Loader2 size={15} className="animate-spin" />
        {block.kind === "agent" ? "Setting up a new agent…" : "Updating…"}
      </div>
    );
  }
  if (!block.payload) return null;

  if (block.kind === "profile") {
    return (
      <div className="card-in my-1.5 inline-flex items-center gap-1.5 rounded-full bg-[var(--app-accent-soft)] px-2.5 py-1 text-xs text-[var(--app-accent)]">
        {state.phase === "done" ? (
          <Check size={12} />
        ) : (
          <Loader2 size={12} className="animate-spin" />
        )}
        {state.phase === "done"
          ? `Profile updated${name ? `: ${emoji} ${name}` : ""}`
          : state.phase === "error"
            ? "Couldn't update the profile"
            : "Updating profile…"}
        {state.phase === "ready" || state.phase === "error" ? (
          <button type="button" className="ml-1 underline" onClick={() => void apply()}>
            Apply
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="card-in my-2 flex items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--app-accent-soft)] text-xl">
        {emoji}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{name ?? "New agent"}</div>
        <div className="truncate text-xs text-[var(--app-muted)]">
          {state.phase === "error" ? state.message : (description ?? "A new agent")}
        </div>
      </div>
      {state.phase === "done" && state.result.result ? (
        <button
          type="button"
          onClick={() => onOpenAgent(state.result.result!.sessionId)}
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--app-fg)] px-3 py-1.5 text-xs font-medium text-[var(--app-bg)]"
        >
          Open <ArrowRight size={13} />
        </button>
      ) : state.phase === "ready" ? (
        <button
          type="button"
          onClick={() => void apply()}
          className="shrink-0 rounded-full bg-[var(--app-accent)] px-3 py-1.5 text-xs font-medium text-white"
        >
          Create
        </button>
      ) : state.phase === "error" ? (
        <button
          type="button"
          onClick={() => void apply()}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--app-border)] px-3 py-1.5 text-xs"
        >
          <RotateCcw size={12} /> Retry
        </button>
      ) : (
        <Loader2 size={16} className="shrink-0 animate-spin text-[var(--app-muted)]" />
      )}
    </div>
  );
}
