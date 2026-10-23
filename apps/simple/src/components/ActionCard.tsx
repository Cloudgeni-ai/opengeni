import { ArrowRight, Check, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { appApi, type AppliedBlock } from "../lib/app-api";
import { AUTO_APPLY_WINDOW_MS, blockKey, type ActionBlock } from "../lib/blocks";
import type { Agent } from "../lib/agents";
import { useAppEvents } from "../lib/app-events";
import { AgentAvatar } from "./AgentAvatar";

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
  findAgent,
}: {
  block: ActionBlock;
  workspaceId: string;
  sourceSessionId: string;
  occurredAt: string;
  onOpenAgent: (sessionId: string) => void;
  findAgent: (sessionId: string) => Agent | undefined;
}) {
  const [state, setState] = useState<State>({ phase: "checking" });
  const keyRef = useRef<string | null>(null);
  const events = useAppEvents();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // Asking to apply again is safe: it returns the result, joins a live
  // attempt, or takes over one that stopped.
  const applyLater = () =>
    setTimeout(() => {
      if (mounted.current) void apply();
    }, 1500);

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
        // The server (or another window) is applying it; look again shortly.
        applyLater();
      } else setState({ phase: "error", message: failedMessage(block.kind) });
    } catch {
      setState({ phase: "error", message: failedMessage(block.kind) });
    }
  };

  const check = async (autoApply: boolean) => {
    if (!block.complete || !block.payload) return;
    keyRef.current ??= await blockKey(sourceSessionId, block);
    const existing = await appApi.getBlock(keyRef.current).catch(() => null);
    if (existing?.state === "applied") setState({ phase: "done", result: existing });
    else if (existing?.state === "applying") applyLater();
    else if (autoApply && Date.now() - Date.parse(occurredAt) < AUTO_APPLY_WINDOW_MS) await apply();
    else setState({ phase: "ready" });
  };

  useEffect(() => {
    void check(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one check per complete block
  }, [block.complete, block.raw, sourceSessionId]);

  // The server keeps retrying in the background; pick up its result.
  useEffect(() => {
    if (state.phase !== "error") return;
    const timer = setInterval(() => {
      if (!keyRef.current) return;
      void appApi.getBlock(keyRef.current).then(
        (existing) => {
          if (existing?.state === "applied") {
            setState({ phase: "done", result: existing });
            events.changed();
          }
        },
        () => {},
      );
    }, 5000);
    return () => clearInterval(timer);
  }, [state.phase, events]);

  const payload = block.payload ?? {};
  const name = typeof payload.name === "string" ? payload.name : null;
  const description = typeof payload.description === "string" ? payload.description : null;

  if (!block.complete) {
    return (
      <div className="card-in my-2 flex items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] px-3 py-2.5 text-sm text-[var(--app-muted)]">
        <Loader2 size={15} className="animate-spin" />
        {block.kind === "agent" ? "Setting up a new agent…" : "Updating…"}
      </div>
    );
  }
  // The agent wrote something unreadable: say so instead of showing nothing.
  if (!block.payload) {
    return (
      <div className="card-in my-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] px-3 py-2.5 text-sm text-[var(--app-muted)]">
        {block.kind === "agent"
          ? "Couldn't set up this agent. Ask again to retry."
          : "Couldn't update the profile. Ask again to retry."}
      </div>
    );
  }
  const shared = payload.shared === true;

  if (block.kind === "profile") {
    // An old profile change that never applied is history, not a to-do.
    if (state.phase === "ready") return null;
    return (
      <div className="card-in my-1.5 inline-flex items-center gap-1.5 rounded-full bg-[var(--app-accent-soft)] px-2.5 py-1 text-xs text-[var(--app-accent)]">
        {state.phase === "done" ? (
          <Check size={12} />
        ) : state.phase === "error" ? null : (
          <Loader2 size={12} className="animate-spin" />
        )}
        {state.phase === "done"
          ? `Profile updated${name ? `: ${name}` : ""}`
          : state.phase === "error"
            ? "Couldn't update the profile"
            : "Updating profile…"}
        {state.phase === "error" ? (
          <button type="button" className="ml-1 underline" onClick={() => void apply()}>
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="card-in my-2 flex items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <CreatedAvatar
        sessionId={state.phase === "done" ? (state.result.result?.sessionId ?? null) : null}
        name={name ?? "New agent"}
        findAgent={findAgent}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{name ?? "New agent"}</span>
          <span className="shrink-0 rounded-full bg-[var(--app-hover)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-muted)]">
            {shared ? "Workspace" : "Personal"}
          </span>
        </div>
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

function failedMessage(kind: ActionBlock["kind"]) {
  return kind === "agent" ? "Couldn't create the agent." : "Couldn't update the profile.";
}

/** The new agent's real avatar once it exists, so the card matches the sidebar. */
function CreatedAvatar({
  sessionId,
  name,
  findAgent,
}: {
  sessionId: string | null;
  name: string;
  findAgent: (sessionId: string) => Agent | undefined;
}) {
  const agent = sessionId ? findAgent(sessionId) : undefined;
  return (
    <AgentAvatar
      agent={agent ?? { id: sessionId ?? name, name, role: "agent", profile: null }}
      size={40}
    />
  );
}
