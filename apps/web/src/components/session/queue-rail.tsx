// The queue rail — the visible heart of the queue-by-default interaction
// model. Shows the running turn (live status + elapsed) and every queued
// turn in execution order; queued turns stay editable, reorderable (buttons
// or drag), and deletable until the worker claims them. All mutations are
// optimistic via `useTurnQueue` and reconcile against the `turn.*` event
// stream; a turn claimed mid-edit gets an explicit "too late" affordance.
import type { UseTurnQueueResult } from "@opengeni/react";
import type { SessionStatus, SessionTurn } from "@opengeni/sdk";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  GripVerticalIcon,
  ListPlusIcon,
  Loader2Icon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatElapsedSeconds, formatTimestamp } from "@/lib/format";
import { listViewState } from "@/lib/load-state";
import {
  editedTurnFate,
  finishedTurns,
  moveTurnInQueue,
  reorderQueueByDrag,
  turnElapsedSeconds,
  turnSourceLabel,
} from "@/lib/queue";
import { cn } from "@/lib/utils";

export function QueueRail({ queue, sessionStatus }: {
  queue: UseTurnQueueResult;
  sessionStatus: SessionStatus;
}) {
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [claimedNotice, setClaimedNotice] = useState<string | null>(null);
  const [draggedTurnId, setDraggedTurnId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const queueIds = queue.queue.map((turn) => turn.id);
  // Honest active-turn area: when the turn list failed to load we do not know
  // whether a turn is running, so never claim "new messages start immediately".
  const activeTurnView = listViewState({ loading: queue.loading, error: queue.error, count: queue.activeTurn ? 1 : 0 });

  // Claimed/too-late reconciliation: if the turn under edit leaves the queue
  // (the worker claimed it, or someone deleted it), close the editor honestly
  // instead of pretending the save would still land.
  useEffect(() => {
    if (!editingTurnId) {
      return;
    }
    const fate = editedTurnFate(queue.turns, editingTurnId);
    if (fate.kind === "editable") {
      return;
    }
    setEditingTurnId(null);
    setEditDraft("");
    if (fate.kind === "claimed") {
      setClaimedNotice("That turn was claimed while you were editing — it is already running, so the edit was not applied.");
    } else if (fate.kind === "cancelled") {
      setClaimedNotice("That turn was deleted while you were editing.");
    }
  }, [queue.turns, editingTurnId]);

  function startEdit(turn: SessionTurn) {
    setClaimedNotice(null);
    setEditingTurnId(turn.id);
    setEditDraft(turn.prompt);
  }

  async function saveEdit(turnId: string) {
    const prompt = editDraft.trim();
    if (!prompt) {
      return;
    }
    setEditingTurnId(null);
    await queue.editTurn(turnId, { prompt });
  }

  async function move(turnId: string, direction: "up" | "down") {
    const next = moveTurnInQueue(queueIds, turnId, direction);
    if (next) {
      await queue.reorderTurns(next);
    }
  }

  async function dropOn(targetId: string) {
    if (!draggedTurnId) {
      return;
    }
    const next = reorderQueueByDrag(queueIds, draggedTurnId, targetId);
    setDraggedTurnId(null);
    setDropTargetId(null);
    if (next) {
      await queue.reorderTurns(next);
    }
  }

  const history = finishedTurns(queue.turns);

  return (
    <div data-testid="queue-rail" className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
          <ListPlusIcon className="size-3.5" />
          Turn queue
        </h3>
        <span className="text-[11px] text-[color:var(--color-fg-subtle)]">
          {queue.queue.length > 0 ? `${queue.queue.length} queued` : activeTurnView === "error" ? "unavailable" : "empty"}
        </span>
      </div>

      {claimedNotice ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs leading-4 text-amber-200">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{claimedNotice}</span>
          <button type="button" onClick={() => setClaimedNotice(null)} aria-label="Dismiss" className="shrink-0 rounded p-0.5 hover:bg-amber-500/20">
            <XIcon className="size-3" />
          </button>
        </div>
      ) : null}

      {queue.mutationError ? (
        <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs leading-4 text-red-200">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{queue.mutationError.message}</span>
          <button type="button" onClick={queue.clearMutationError} aria-label="Dismiss queue error" className="shrink-0 rounded p-0.5 hover:bg-red-500/20">
            <XIcon className="size-3" />
          </button>
        </div>
      ) : null}

      {queue.activeTurn ? (
        <ActiveTurnCard turn={queue.activeTurn} />
      ) : activeTurnView === "loading" ? (
        <div className="flex items-center gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3 text-xs text-[color:var(--color-fg-muted)]">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading turns
        </div>
      ) : activeTurnView === "error" ? (
        <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs leading-4 text-red-200" role="alert">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">Couldn't load the turn queue{queue.error?.message ? ` — ${queue.error.message}` : ""}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => void queue.refresh()} className="shrink-0 text-red-200 hover:bg-red-500/20 hover:text-red-100">
            Retry
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-3 text-xs leading-5 text-[color:var(--color-fg-subtle)]">
          {sessionStatus === "failed"
            ? "No turn is running — the session failed. Send a message to revive it."
            : "No turn is running. New messages start immediately."}
        </div>
      )}

      {queue.queue.length > 0 ? (
        <ol className="space-y-1.5" aria-label="Queued turns">
          {queue.queue.map((turn, index) => (
            <li
              key={turn.id}
              draggable={editingTurnId !== turn.id}
              onDragStart={() => setDraggedTurnId(turn.id)}
              onDragEnd={() => {
                setDraggedTurnId(null);
                setDropTargetId(null);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDropTargetId(turn.id);
              }}
              onDragLeave={() => setDropTargetId((current) => (current === turn.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                void dropOn(turn.id);
              }}
              className={cn(
                "group rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-2 transition-colors",
                dropTargetId === turn.id && draggedTurnId !== turn.id && "border-[color:var(--color-brand)]/60 bg-[color:var(--color-brand)]/10",
                draggedTurnId === turn.id && "opacity-50",
              )}
            >
              {editingTurnId === turn.id ? (
                <div className="space-y-2">
                  <textarea
                    value={editDraft}
                    onChange={(event) => setEditDraft(event.target.value)}
                    autoFocus
                    aria-label={`Edit queued turn ${index + 1}`}
                    className="min-h-16 w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2.5 py-2 text-xs leading-5"
                  />
                  <div className="flex items-center justify-end gap-1.5">
                    <Button type="button" variant="ghost" size="xs" onClick={() => setEditingTurnId(null)}>
                      Cancel
                    </Button>
                    <Button type="button" size="xs" disabled={!editDraft.trim() || queue.mutating} onClick={() => void saveEdit(turn.id)}>
                      {queue.mutating ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 flex shrink-0 cursor-grab items-center gap-1 text-[color:var(--color-fg-subtle)]" title="Drag to reorder">
                    <GripVerticalIcon className="size-3.5" />
                    <span className="font-mono text-[10px]">#{index + 1}</span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-xs leading-5 text-[color:var(--color-fg)]">{turn.prompt}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[color:var(--color-fg-subtle)]">
                      <span>{turnSourceLabel(turn.source)}</span>
                      <span>{formatTimestamp(turn.createdAt)}</span>
                    </div>
                  </div>
                  <span className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={index === 0 || queue.mutating}
                      onClick={() => void move(turn.id, "up")}
                      aria-label="Move turn earlier"
                    >
                      <ChevronUpIcon className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={index === queueIds.length - 1 || queue.mutating}
                      onClick={() => void move(turn.id, "down")}
                      aria-label="Move turn later"
                    >
                      <ChevronDownIcon className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={queue.mutating}
                      onClick={() => startEdit(turn)}
                      aria-label="Edit queued turn"
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={queue.mutating}
                      onClick={() => void queue.removeTurn(turn.id)}
                      aria-label="Delete queued turn"
                      className="hover:text-red-300"
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ol>
      ) : null}

      {history.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg-muted)]">
            <ChevronDownIcon className="mr-1 inline size-3 transition-transform group-open:rotate-180" />
            {history.length} finished turn{history.length === 1 ? "" : "s"}
          </summary>
          <ol className="mt-2 space-y-1">
            {history.slice(0, 12).map((turn) => (
              <li key={turn.id} className="flex min-w-0 items-center gap-2 rounded-md border border-[color:var(--color-border)]/70 bg-[color:var(--color-bg)]/25 px-2 py-1.5">
                <TurnStatusDot status={turn.status} />
                <span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--color-fg-muted)]">{turn.prompt}</span>
                <span className="shrink-0 text-[10px] text-[color:var(--color-fg-subtle)]">{turn.status}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

function ActiveTurnCard({ turn }: { turn: SessionTurn }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const awaitingApproval = turn.status === "requires_action";
  return (
    <div
      data-testid="active-turn"
      className={cn(
        "rounded-lg border p-2.5",
        awaitingApproval
          ? "border-amber-500/40 bg-amber-500/10"
          : "border-[color:var(--color-brand)]/40 bg-[color:var(--color-brand)]/10",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          <TurnStatusDot status={turn.status} />
          {awaitingApproval ? "Awaiting approval" : "Running"}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-[color:var(--color-fg-muted)]" aria-label="Elapsed time">
          {turn.startedAt ? formatElapsedSeconds(turnElapsedSeconds(turn, now)) : "starting"}
        </span>
      </div>
      <div className="mt-1.5 line-clamp-3 text-xs leading-5 text-[color:var(--color-fg)]">{turn.prompt}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[color:var(--color-fg-subtle)]">
        <span>{turnSourceLabel(turn.source)}</span>
        <span>{turn.model}</span>
        <span>{turn.reasoningEffort}</span>
      </div>
    </div>
  );
}

function TurnStatusDot({ status }: { status: SessionTurn["status"] }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "running" && "animate-pulse bg-emerald-400",
        status === "requires_action" && "animate-pulse bg-amber-400",
        status === "queued" && "bg-sky-400",
        status === "completed" && "bg-emerald-600",
        status === "failed" && "bg-red-400",
        status === "cancelled" && "bg-zinc-500",
      )}
      aria-hidden="true"
    />
  );
}
