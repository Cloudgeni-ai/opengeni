import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SessionTurn } from "@opengeni/sdk";
import {
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  ChevronDownIcon,
  EllipsisIcon,
  GripVerticalIcon,
  Loader2Icon,
  PencilIcon,
  RotateCwIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { useCallback, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { DropdownMenu } from "radix-ui";
import type { ComposerState } from "../hooks/use-composer";
import type { QueueMutationKind, UseTurnQueueResult } from "../hooks/use-turn-queue";

/** The sole human prompt queue: compact above Goal, Agents, and composer. */
export type QueueSurfaceProps =
  | {
      queue: UseTurnQueueResult;
      composer: ComposerState;
      readOnly?: false | undefined;
    }
  | {
      queue: UseTurnQueueResult;
      composer?: undefined;
      readOnly: true;
    };

export function requestQueueDraftEdit(
  composer: Pick<ComposerState, "hasDraftContent">,
  confirmReplacement: () => void,
  editImmediately: () => void,
): void {
  if (composer.hasDraftContent()) {
    confirmReplacement();
  } else {
    editImmediately();
  }
}

export function QueueSurface({ queue, composer, readOnly = false }: QueueSurfaceProps) {
  const [open, setOpen] = useState(false);
  const [replaceDraftFor, setReplaceDraftFor] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [draggedTurnId, setDraggedTurnId] = useState<string | null>(null);
  const [keyboardDrag, setKeyboardDrag] = useState<{
    turnId: string;
    projectedIndex: number;
  } | null>(null);
  const count = queue.queue.length;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const displayedQueue = useMemo(() => {
    if (!keyboardDrag) return queue.queue;
    const oldIndex = queue.queue.findIndex((turn) => turn.id === keyboardDrag.turnId);
    if (oldIndex < 0) return queue.queue;
    return arrayMove(queue.queue, oldIndex, keyboardDrag.projectedIndex);
  }, [keyboardDrag, queue.queue]);

  const ids = useMemo(() => displayedQueue.map((turn) => turn.id), [displayedQueue]);
  const moveToIndex = useCallback(
    async (turnId: string, nextIndex: number): Promise<void> => {
      const oldIndex = queue.queue.findIndex((turn) => turn.id === turnId);
      if (oldIndex < 0) return;
      const boundedIndex = Math.max(0, Math.min(nextIndex, queue.queue.length - 1));
      if (oldIndex === boundedIndex) return;
      const ordered = arrayMove(queue.queue, oldIndex, boundedIndex);
      const beforeTurnId = ordered[boundedIndex + 1]?.id ?? null;
      const moved = await queue.moveTurn(turnId, beforeTurnId);
      setAnnouncement(
        moved
          ? `Queued prompt moved to position ${boundedIndex + 1}.`
          : "The queue changed before that prompt could be moved. Refreshed server order.",
      );
      if (moved) focusQueueTurn(turnId);
    },
    [queue],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggedTurnId(null);
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : null;
      if (!overId || activeId === overId) {
        setAnnouncement("Queued prompt returned to its original position.");
        return;
      }
      const nextIndex = queue.queue.findIndex((turn) => turn.id === overId);
      if (nextIndex >= 0) void moveToIndex(activeId, nextIndex);
    },
    [moveToIndex, queue.queue],
  );

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      setKeyboardDrag(null);
      const turnId = String(event.active.id);
      const position = queue.queue.findIndex((turn) => turn.id === turnId) + 1;
      setDraggedTurnId(turnId);
      setAnnouncement(`Dragging queued prompt ${position} of ${queue.queue.length}.`);
    },
    [queue.queue],
  );

  const onHandleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, turnId: string) => {
      const canonicalIndex = queue.queue.findIndex((turn) => turn.id === turnId);
      if (canonicalIndex < 0) return;

      if (!keyboardDrag) {
        if (event.key !== " ") return;
        event.preventDefault();
        setKeyboardDrag({ turnId, projectedIndex: canonicalIndex });
        setAnnouncement(
          `Lifted queued prompt ${canonicalIndex + 1} of ${count}. Use arrow keys to move it, then press Space to drop.`,
        );
        return;
      }
      if (keyboardDrag.turnId !== turnId) return;

      if (event.key === "Escape") {
        event.preventDefault();
        setKeyboardDrag(null);
        setAnnouncement("Queue reorder cancelled.");
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        const targetIndex = keyboardDrag.projectedIndex;
        setAnnouncement(`Moving queued prompt to position ${targetIndex + 1}.`);
        void moveToIndex(turnId, targetIndex).finally(() => setKeyboardDrag(null));
        return;
      }

      const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      const edge = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
      if (direction === 0 && edge === null) return;
      event.preventDefault();
      const projectedIndex = Math.max(
        0,
        Math.min(edge ?? keyboardDrag.projectedIndex + direction, count - 1),
      );
      setKeyboardDrag({ turnId, projectedIndex });
      setAnnouncement(`Queued prompt projected to position ${projectedIndex + 1} of ${count}.`);
    },
    [count, keyboardDrag, moveToIndex, queue.queue],
  );

  const edit = useCallback(
    async (turn: SessionTurn, replaceDraft: boolean) => {
      if (!composer || readOnly) return;
      const restored = await queue.editTurn(turn.id, {
        expectedDraftRevision: composer.draftRevision,
        replaceDraft,
      });
      if (!restored) return;
      composer.applyDraft(restored);
      setReplaceDraftFor(null);
      setAnnouncement("Queued prompt moved back to the composer for editing.");
      window.requestAnimationFrame(() => {
        const input = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message the agent"]',
        );
        input?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        input?.focus();
      });
    },
    [composer, queue, readOnly],
  );

  const requestEdit = useCallback(
    (turn: SessionTurn) => {
      if (!composer || readOnly) return;
      requestQueueDraftEdit(
        composer,
        () => setReplaceDraftFor(turn.id),
        () => void edit(turn, false),
      );
    },
    [composer, edit, readOnly],
  );

  if (count === 0 && !queue.stoppingPreviousAttempt && !queue.error && !queue.mutationError)
    return null;

  return (
    <div
      className="mx-auto mb-2 w-full max-w-3xl shrink-0 px-4 sm:px-6"
      data-testid="queue-surface"
    >
      <div className="overflow-hidden rounded-lg border border-border bg-surface/80 shadow-sm">
        {queue.stoppingPreviousAttempt ? (
          <div
            role="status"
            aria-live="polite"
            className="flex min-h-11 items-center gap-2.5 border-b border-status-waiting/20 bg-status-waiting/[0.07] px-3 py-2 text-xs text-fg"
            data-testid="stopping-previous-attempt"
          >
            <Loader2Icon
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-spin text-status-waiting motion-reduce:animate-none"
            />
            <span className="min-w-0">
              <span className="font-medium">
                {queue.effectiveControl?.state === "paused"
                  ? "Stopping current attempt…"
                  : "Stopping previous attempt…"}
              </span>{" "}
              <span className="text-fg-muted">
                {queue.effectiveControl?.state === "paused"
                  ? "Queued work stays saved until you resume."
                  : "Queued work is saved and starts automatically."}
              </span>
            </span>
          </div>
        ) : null}
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 pointer-coarse:min-h-11"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <ChevronDownIcon
            className={`size-3.5 shrink-0 text-fg-subtle transition-transform ${open ? "rotate-180" : ""}`}
          />
          <span className="text-xs font-medium text-fg">
            {count} queued prompt{count === 1 ? "" : "s"}
          </span>
          {readOnly ? (
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-2xs text-fg-subtle">
              Read-only
            </span>
          ) : null}
          {!open && count > 0 ? (
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
              {queue.queue[0]?.prompt}
            </span>
          ) : null}
          {queue.loading ? <Loader2Icon className="ml-auto size-3.5 animate-spin" /> : null}
        </button>

        {open && count > 0 && readOnly ? (
          <ol className="divide-y divide-border border-t border-border" aria-label="Queued prompts">
            {queue.queue.map((turn, index) => (
              <ReadOnlyQueueRow key={turn.id} turn={turn} index={index} />
            ))}
          </ol>
        ) : null}

        {open && count > 0 && !readOnly ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[verticalOnly]}
            onDragStart={onDragStart}
            onDragCancel={() => {
              setDraggedTurnId(null);
              setAnnouncement("Queue reorder cancelled.");
            }}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <ol
                className="divide-y divide-border border-t border-border"
                aria-label="Queued prompts"
              >
                {displayedQueue.map((turn, index) => (
                  <SortableQueueRow
                    key={turn.id}
                    turn={turn}
                    index={index}
                    count={count}
                    pending={queue.mutationFor(turn.id)}
                    confirmingReplace={replaceDraftFor === turn.id}
                    keyboardDragging={keyboardDrag?.turnId === turn.id}
                    onHandleKeyDown={(event) => onHandleKeyDown(event, turn.id)}
                    onMove={(nextIndex) => void moveToIndex(turn.id, nextIndex)}
                    onEdit={() => requestEdit(turn)}
                    onConfirmReplace={() => void edit(turn, true)}
                    onCancelReplace={() => setReplaceDraftFor(null)}
                    onSteer={() => {
                      void queue.steerTurn(turn.id).then((steered) => {
                        setAnnouncement(
                          steered
                            ? "Queued prompt is now the next direction."
                            : "That prompt changed before it could be steered.",
                        );
                        if (steered) focusAfterQueueRemoval(index);
                      });
                    }}
                    onDelete={() => {
                      void queue.removeTurn(turn.id).then((removed) => {
                        setAnnouncement(
                          removed
                            ? "Queued prompt deleted."
                            : "That prompt changed before it could be deleted.",
                        );
                        if (removed) focusAfterQueueRemoval(index);
                      });
                    }}
                  />
                ))}
              </ol>
            </SortableContext>
            <DragOverlay modifiers={[verticalOnly]}>
              {draggedTurnId ? (
                <div className="max-w-xl rounded-md border border-brand/40 bg-surface px-3 py-2 text-xs text-fg shadow-lg">
                  {queue.queue.find((turn) => turn.id === draggedTurnId)?.prompt}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : null}

        {queue.error || queue.mutationError ? (
          <div className="border-t border-border p-2">
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md bg-status-failed/10 px-2 py-1.5 text-xs text-status-failed"
            >
              <span className="min-w-0 flex-1">
                {(queue.mutationError ?? queue.error)?.message}
              </span>
              <button
                type="button"
                onClick={() => {
                  queue.clearMutationError();
                  void queue.refresh();
                }}
                aria-label="Dismiss queue error and retry"
                title="Retry loading the queue"
                className="inline-flex size-7 items-center justify-center rounded-md outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-11"
              >
                <RotateCwIcon className="size-3.5" />
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </div>
  );
}

function ReadOnlyQueueRow({ turn, index }: { turn: SessionTurn; index: number }) {
  return (
    <li className="flex min-w-0 items-start gap-2 bg-surface px-3 py-2">
      <span className="mt-1 shrink-0 font-mono text-2xs text-fg-subtle">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words text-xs leading-5 text-fg">{turn.prompt}</p>
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-fg-subtle">
          {turn.resources.length > 0 ? (
            <span>
              {turn.resources.length} resource{turn.resources.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {turn.tools.length > 0 ? (
            <span>
              {turn.tools.length} tool{turn.tools.length === 1 ? "" : "s"}
            </span>
          ) : null}
          <span>{turn.model}</span>
          <span>{turn.reasoningEffort}</span>
        </div>
      </div>
    </li>
  );
}

function SortableQueueRow({
  turn,
  index,
  count,
  pending,
  confirmingReplace,
  keyboardDragging,
  onHandleKeyDown,
  onMove,
  onEdit,
  onConfirmReplace,
  onCancelReplace,
  onSteer,
  onDelete,
}: {
  turn: SessionTurn;
  index: number;
  count: number;
  pending: QueueMutationKind | null;
  confirmingReplace: boolean;
  keyboardDragging: boolean;
  onHandleKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onMove: (index: number) => void;
  onEdit: () => void;
  onConfirmReplace: () => void;
  onCancelReplace: () => void;
  onSteer: () => void;
  onDelete: () => void;
}) {
  const sortable = useSortable({
    id: turn.id,
    disabled: pending !== null || keyboardDragging,
  });
  return (
    <li
      data-queue-turn-id={turn.id}
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={`bg-surface ${sortable.isDragging || keyboardDragging ? "relative z-10 shadow-lg ring-1 ring-brand/40" : ""}`}
    >
      <div className="flex min-w-0 items-start gap-1.5 px-2 py-2 sm:gap-2 sm:px-3">
        <button
          data-queue-handle
          ref={sortable.setActivatorNodeRef}
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          onKeyDown={onHandleKeyDown}
          disabled={pending !== null}
          className="mt-0.5 inline-flex size-7 shrink-0 touch-none items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-11"
          aria-label={`Reorder queued prompt ${index + 1}`}
          title="Drag to reorder. Press Space, arrows, then Space to drop."
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        <span className="mt-1 shrink-0 font-mono text-2xs text-fg-subtle">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-xs leading-5 text-fg">{turn.prompt}</p>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-2xs text-fg-subtle">
            {turn.resources.length > 0 ? (
              <span>
                {turn.resources.length} resource{turn.resources.length === 1 ? "" : "s"}
              </span>
            ) : null}
            {turn.tools.length > 0 ? (
              <span>
                {turn.tools.length} tool{turn.tools.length === 1 ? "" : "s"}
              </span>
            ) : null}
            <span>{turn.model}</span>
            <span>{turn.reasoningEffort}</span>
          </div>
        </div>
        <button
          type="button"
          disabled={pending !== null}
          onClick={onSteer}
          aria-label={`Steer queued prompt ${index + 1}`}
          title="Make this the next direction"
          className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11"
        >
          {pending === "steer" ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <ZapIcon className="size-3.5" />
          )}
          <span className="hidden sm:inline">Steer</span>
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={onDelete}
          aria-label={`Delete queued prompt ${index + 1}`}
          title="Delete this queued prompt"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-surface-2 hover:text-status-failed focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-11"
        >
          {pending === "delete" ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <Trash2Icon className="size-3.5" />
          )}
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              disabled={pending !== null}
              aria-label={`More actions for queued prompt ${index + 1}`}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-11"
            >
              {pending && pending !== "steer" && pending !== "delete" ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <EllipsisIcon className="size-3.5" />
              )}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-50 w-48 rounded-md border border-border bg-surface p-1 text-xs text-fg shadow-lg"
            >
              <DropdownMenu.Item
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none focus:bg-surface-2"
                onSelect={onEdit}
              >
                <PencilIcon className="size-3.5" /> Edit in composer
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none focus:bg-surface-2 data-[disabled]:opacity-50"
                disabled={index === 0}
                onSelect={() => onMove(0)}
              >
                <ArrowUpToLineIcon className="size-3.5" /> Move to top
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none focus:bg-surface-2 data-[disabled]:opacity-50"
                disabled={index === 0}
                onSelect={() => onMove(index - 1)}
              >
                Move up
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none focus:bg-surface-2 data-[disabled]:opacity-50"
                disabled={index === count - 1}
                onSelect={() => onMove(index + 1)}
              >
                Move down
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none focus:bg-surface-2 data-[disabled]:opacity-50"
                disabled={index === count - 1}
                onSelect={() => onMove(count - 1)}
              >
                <ArrowDownToLineIcon className="size-3.5" /> Move to bottom
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {confirmingReplace ? (
        <div className="mx-3 mb-2 rounded-md border border-status-waiting/30 bg-status-waiting/10 p-2 text-xs text-fg">
          <p>Your composer already has a draft. Replace it with this queued prompt?</p>
          <p className="mt-0.5 text-fg-muted">
            The current draft will be permanently discarded; this queued prompt is preserved until
            you confirm.
          </p>
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              className="rounded-md px-2 py-1 font-medium hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={onCancelReplace}
            >
              Keep current draft
            </button>
            <button
              type="button"
              className="rounded-md bg-brand px-2 py-1 font-medium text-white hover:bg-brand/90 focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={onConfirmReplace}
            >
              Replace and edit
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function focusQueueTurn(turnId: string): void {
  window.requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(`[data-queue-turn-id="${turnId}"] [data-queue-handle]`)
      ?.focus();
  });
}

function focusAfterQueueRemoval(previousIndex: number): void {
  window.requestAnimationFrame(() => {
    const handles = document.querySelectorAll<HTMLElement>("[data-queue-handle]");
    const nearest = handles[Math.min(previousIndex, Math.max(0, handles.length - 1))];
    if (nearest) {
      nearest.focus();
      return;
    }
    document
      .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the agent"]')
      ?.focus();
  });
}
