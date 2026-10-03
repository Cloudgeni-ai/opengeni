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
import type { SessionPendingInputPreview, SessionTurn, TimelineAnnotation } from "@opengeni/sdk";
import { modelDisplayName } from "@opengeni/sdk/model-display";
import {
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  ChevronDownIcon,
  EllipsisIcon,
  GripVerticalIcon,
  Loader2Icon,
  PencilIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import {
  useCallback,
  useId,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { DropdownMenu } from "radix-ui";
import { MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS, MENU_SURFACE_CLASS } from "../lib/menu-styles";
import type { ComposerState } from "../hooks/use-composer";
import type { QueueMutationKind, UseTurnQueueResult } from "../hooks/use-turn-queue";
import {
  type PortalTokenStyle,
  usePortalTokenSource,
  usePortalTokenStyle,
} from "../lib/use-portal-token-style";
import { requestQueueDraftEdit } from "./queue-draft-policy";
import {
  projectPendingQueueMove,
  QUEUE_COLLAPSED_PREVIEW_CHARACTERS,
  QUEUE_REPLACE_DRAFT_COPY,
  QUEUE_ROW_PREVIEW_CHARACTERS,
  queueContentPreview,
  queueMovePlan,
  queuePromptPreview,
  queueTurnPreview,
} from "../queue-presentation-model";
import { QUEUE_ITEM_CONTENT_UNAVAILABLE, queueItemContent } from "./queue-item-content";
import { QueueErrorAlert, QueueStoppingStatus } from "./queue-surface-state";
import { TimelineAnnotationsChip } from "./timeline-annotations";

// Queued prompts can be long; menu rows wrap instead of truncating.
const QUEUE_MENU_ITEM_CLASS = `${MENU_ITEM_CLASS} whitespace-normal break-words`;

/** The sole pending-input surface: compact above Goal, Agents, and composer. */
type QueueSurfaceCommonProps = {
  /** Focus the composer owned by this queue after checkout/removal. */
  onRequestComposerFocus?: (() => void) | undefined;
};

export type QueueSurfaceProps =
  | (QueueSurfaceCommonProps & {
      queue: UseTurnQueueResult;
      composer: ComposerState;
      readOnly?: false | undefined;
    })
  | (QueueSurfaceCommonProps & {
      queue: UseTurnQueueResult;
      composer?: undefined;
      readOnly: true;
    });

/** @internal Pure policy seam for queue/composer embedding tests. */
export function queueComposerCheckoutEnabled(
  composer: ComposerState | undefined,
  readOnly: boolean,
): boolean {
  return !readOnly && composer !== undefined && composer.draftPersistence !== "disabled";
}

export function QueueSurface({
  queue,
  composer,
  readOnly = false,
  onRequestComposerFocus,
}: QueueSurfaceProps) {
  const [open, setOpen] = useState(false);
  const [replaceDraftFor, setReplaceDraftFor] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [draggedTurnId, setDraggedTurnId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    baseVersion: number | null;
    turnIds: string[];
  } | null>(null);
  const surface = usePortalTokenSource<HTMLDivElement>();
  const surfaceRef = surface.currentRef;
  const portalTokenStyle = usePortalTokenStyle(surface.source);
  const [keyboardDrag, setKeyboardDrag] = useState<{
    turnId: string;
    projectedIndex: number;
  } | null>(null);
  const count = queue.queue.length;
  const pendingInputCount = queue.pendingInputs.length;
  const totalCount = count + pendingInputCount;
  const attachedInputIds = queue.pendingInputAttachment?.inputIds ?? [];
  const attachedInputs = queue.pendingInputs.filter((input) => attachedInputIds.includes(input.id));
  const standaloneInputs = queue.pendingInputs.filter(
    (input) => !attachedInputIds.includes(input.id),
  );
  const canEditInComposer = queueComposerCheckoutEnabled(composer, readOnly);
  const collapsedPreview = useMemo(() => {
    const firstTurn = queue.queue[0];
    return firstTurn
      ? queueTurnPreview(firstTurn, QUEUE_COLLAPSED_PREVIEW_CHARACTERS)
      : queuePromptPreview(
          queue.pendingInputs[0]?.summary ?? "",
          QUEUE_COLLAPSED_PREVIEW_CHARACTERS,
        );
  }, [queue.pendingInputs, queue.queue]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const displayedQueue = useMemo(() => {
    if (keyboardDrag) {
      const oldIndex = queue.queue.findIndex((turn) => turn.id === keyboardDrag.turnId);
      if (oldIndex < 0) return queue.queue;
      return arrayMove(queue.queue, oldIndex, keyboardDrag.projectedIndex);
    }
    // Never let an optimistic ordering projection omit or invent a row. Any
    // concurrent authoritative membership change wins immediately.
    return projectPendingQueueMove(queue.queue, pendingMove, queue.snapshot);
  }, [keyboardDrag, pendingMove, queue.queue, queue.snapshot]);

  const ids = useMemo(() => displayedQueue.map((turn) => turn.id), [displayedQueue]);
  const moveToIndex = useCallback(
    async (turnId: string, nextIndex: number): Promise<void> => {
      if (queue.mutating || pendingMove) return;
      const plan = queueMovePlan(queue.queue, turnId, nextIndex);
      if (!plan) return;
      const { beforeTurnId, index: boundedIndex } = plan;
      setPendingMove({
        baseVersion: queue.snapshot?.version ?? null,
        turnIds: plan.turnIds,
      });
      setAnnouncement(`Saving queued prompt at position ${boundedIndex + 1}.`);
      try {
        const moved = await queue.moveTurn(turnId, beforeTurnId);
        setAnnouncement(
          moved
            ? `Queued prompt moved to position ${boundedIndex + 1}.`
            : "The queue changed before that prompt could be moved. Refreshed server order.",
        );
        if (moved) focusQueueTurn(surfaceRef.current, turnId);
      } finally {
        setPendingMove(null);
      }
    },
    [pendingMove, queue, surfaceRef],
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
      if (!composer || !canEditInComposer) return;
      setAnnouncement("Moving queued prompt to the composer…");
      const restored = await queue.editTurn(turn.id, {
        expectedDraftRevision: composer.draftRevision,
        replaceDraft,
      });
      if (!restored) {
        setAnnouncement("That prompt changed before it could be moved to the composer.");
        return;
      }
      composer.applyDraft(restored);
      setReplaceDraftFor(null);
      setAnnouncement("Queued prompt moved back to the composer for editing.");
      window.requestAnimationFrame(() => {
        if (onRequestComposerFocus) {
          onRequestComposerFocus();
          return;
        }
        const input = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message the agent"]',
        );
        input?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        input?.focus();
      });
    },
    [canEditInComposer, composer, onRequestComposerFocus, queue],
  );

  const requestEdit = useCallback(
    (turn: SessionTurn) => {
      if (!composer || !canEditInComposer) return;
      requestQueueDraftEdit(
        composer,
        () => setReplaceDraftFor(turn.id),
        () => void edit(turn, false),
      );
    },
    [canEditInComposer, composer, edit],
  );

  if (totalCount === 0 && !queue.stoppingPreviousAttempt && !queue.error && !queue.mutationError)
    return null;

  return (
    <div
      ref={surface.ref}
      className="og-root mx-auto mb-2 w-full max-w-3xl shrink-0 px-4 sm:px-6"
      data-testid="queue-surface"
    >
      <div className="overflow-hidden rounded-lg border border-border bg-surface/80 shadow-sm">
        {queue.stoppingPreviousAttempt ? <QueueStoppingStatus queue={queue} dividerAfter /> : null}
        <button
          type="button"
          className="flex w-full min-w-0 flex-wrap items-center gap-2 px-3 py-2 text-left outline-hidden transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 pointer-coarse:min-h-[44px]"
          onClick={() => setOpen((value) => !value)}
          aria-description={!open && totalCount > 0 ? collapsedPreview.summary : undefined}
          aria-expanded={open}
          aria-label={`${count} queued prompt${count === 1 ? "" : "s"}${
            pendingInputCount > 0
              ? ` and ${pendingInputCount} pending machine input${pendingInputCount === 1 ? "" : "s"}`
              : ""
          }${readOnly ? " Read-only" : ""}`}
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-3.5 shrink-0 text-fg-subtle transition-transform ${open ? "rotate-180" : ""}`}
          />
          <span className="text-og-control font-medium text-fg">
            {count > 0 ? `${count} queued prompt${count === 1 ? "" : "s"}` : null}
            {count > 0 && pendingInputCount > 0 ? " · " : null}
            {pendingInputCount > 0
              ? `${pendingInputCount} incoming update${pendingInputCount === 1 ? "" : "s"}`
              : null}
          </span>
          {readOnly ? (
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-og-xs text-fg-subtle">
              Read-only
            </span>
          ) : null}
          {!open && totalCount > 0 ? (
            <span
              aria-hidden="true"
              className={`max-w-full truncate text-fg-muted ${
                collapsedPreview.collapsedVisual === collapsedPreview.summary
                  ? "min-w-0 flex-1 text-og-control"
                  : "shrink-0 text-[10px]"
              }`}
              data-testid="queue-collapsed-preview"
              dir="auto"
            >
              {collapsedPreview.collapsedVisual}
            </span>
          ) : null}
          {queue.loading ? <Loader2Icon className="ml-auto size-3.5 animate-spin" /> : null}
        </button>

        {open && standaloneInputs.length > 0 ? (
          <PendingMachineInputs inputs={standaloneInputs} />
        ) : null}

        {open && count > 0 && readOnly ? (
          <ol
            className="max-h-[min(30rem,60dvh)] divide-y divide-border overflow-y-auto overscroll-contain border-t border-border"
            aria-label="Queued prompts"
            data-testid="queue-list"
          >
            {queue.queue.map((turn, index) => (
              <ReadOnlyQueueRow
                key={turn.id}
                turn={turn}
                index={index}
                attachedInputs={
                  turn.id === queue.pendingInputAttachment?.turnId ? attachedInputs : []
                }
                onDisclosureChange={(expanded) =>
                  setAnnouncement(
                    `Full content for queued prompt ${index + 1} ${expanded ? "shown" : "hidden"}.`,
                  )
                }
              />
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
                className="max-h-[min(30rem,60dvh)] divide-y divide-border overflow-y-auto overscroll-contain border-t border-border"
                aria-label="Queued prompts"
                data-testid="queue-list"
              >
                {displayedQueue.map((turn, index) => (
                  <SortableQueueRow
                    key={turn.id}
                    turn={turn}
                    index={index}
                    count={count}
                    attachedInputs={
                      turn.id === queue.pendingInputAttachment?.turnId ? attachedInputs : []
                    }
                    pending={queue.mutationFor(turn.id)}
                    reorderDisabled={queue.mutating || pendingMove !== null}
                    confirmingReplace={replaceDraftFor === turn.id}
                    keyboardDragging={keyboardDrag?.turnId === turn.id}
                    portalTokenStyle={portalTokenStyle}
                    onHandleKeyDown={(event) => onHandleKeyDown(event, turn.id)}
                    onMove={(nextIndex) => void moveToIndex(turn.id, nextIndex)}
                    onEdit={canEditInComposer ? () => requestEdit(turn) : undefined}
                    onConfirmReplace={() => void edit(turn, true)}
                    onCancelReplace={() => setReplaceDraftFor(null)}
                    onSteer={() => {
                      setAnnouncement("Requesting this queued prompt as the next direction…");
                      void queue.steerTurn(turn.id).then((steered) => {
                        setAnnouncement(
                          steered
                            ? "Queued prompt is now the next direction."
                            : "That prompt changed before it could be steered.",
                        );
                        if (steered) {
                          focusAfterQueueRemoval(surfaceRef.current, index, onRequestComposerFocus);
                        }
                      });
                    }}
                    onDelete={() => {
                      setAnnouncement("Deleting queued prompt…");
                      void queue.removeTurn(turn.id).then((removed) => {
                        setAnnouncement(
                          removed
                            ? "Queued prompt deleted."
                            : "That prompt changed before it could be deleted.",
                        );
                        if (removed) {
                          focusAfterQueueRemoval(surfaceRef.current, index, onRequestComposerFocus);
                        }
                      });
                    }}
                    onDisclosureChange={(expanded) =>
                      setAnnouncement(
                        `Full content for queued prompt ${index + 1} ${expanded ? "shown" : "hidden"}.`,
                      )
                    }
                  />
                ))}
              </ol>
            </SortableContext>
            <DragOverlay modifiers={[verticalOnly]}>
              {draggedTurnId ? (
                <div
                  className="max-h-20 w-[min(36rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-brand/40 bg-surface px-3 py-2 text-og-control text-fg shadow-lg"
                  data-testid="queue-drag-overlay"
                >
                  <p
                    aria-hidden="true"
                    className="line-clamp-3 break-all whitespace-pre-wrap [unicode-bidi:plaintext]"
                    dir="auto"
                  >
                    {
                      queueTurnPreview(
                        queue.queue.find((turn) => turn.id === draggedTurnId),
                        QUEUE_ROW_PREVIEW_CHARACTERS,
                      ).summary
                    }
                  </p>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : null}

        {queue.error || queue.mutationError ? (
          <QueueErrorAlert queue={queue} dividerBefore />
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </div>
  );
}

function PendingMachineInputs({
  inputs,
  attached = false,
}: {
  inputs: SessionPendingInputPreview[];
  attached?: boolean;
}) {
  return (
    <section className="border-t border-border px-3 py-2">
      <p className="text-og-xs font-medium text-fg-subtle">
        {attached
          ? `${inputs.length} update${inputs.length === 1 ? "" : "s"} will join this prompt`
          : "Incoming updates waiting to run"}
      </p>
      <ol className="mt-1 space-y-1">
        {inputs.map((input) => (
          <li
            key={input.id}
            className="line-clamp-3 break-words text-og-control text-fg"
            dir="auto"
          >
            <strong className="capitalize text-fg-muted">
              {input.kind.replace("_terminal", "").replaceAll("_", " ")}
            </strong>{" "}
            · {input.sourceId}
            {input.summary ? ` — ${input.summary}` : ""}
          </li>
        ))}
      </ol>
    </section>
  );
}

function QueuePrompt({
  prompt,
  annotations,
  index,
  onDisclosureChange,
}: {
  prompt: string;
  annotations: readonly TimelineAnnotation[];
  index: number;
  onDisclosureChange: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const fullContentId = useId();
  const content = queueItemContent(prompt, annotations.length);
  const preview = useMemo(
    () => queueContentPreview(prompt, annotations.length, QUEUE_ROW_PREVIEW_CHARACTERS),
    [annotations.length, prompt],
  );

  return (
    <div className="w-full min-w-0 max-w-full">
      {prompt ? (
        <div
          aria-label={`Queued prompt ${index + 1} summary: ${preview.summary}`}
          className="max-w-full overflow-hidden text-og-control leading-5 text-fg"
          data-testid={`queue-prompt-preview-${index + 1}`}
          dir="auto"
          role="note"
        >
          <span
            aria-hidden="true"
            className="flex min-w-0 max-w-full items-baseline gap-2 sm:block"
          >
            <span
              className={`${preview.isFallback ? "" : "line-clamp-1 sm:line-clamp-2"} min-w-0 flex-1 whitespace-pre-wrap break-all [unicode-bidi:plaintext]`}
              data-testid={`queue-prompt-start-${index + 1}`}
              dir="auto"
            >
              {preview.visibleStart}
            </span>
            {preview.visibleIdentity && preview.visibleIdentityLabel ? (
              <span
                className="flex min-w-0 max-w-[70%] shrink-0 items-center gap-1 text-og-xs leading-4 text-fg-muted sm:mt-0.5 sm:max-w-full"
                data-testid={`queue-prompt-identity-row-${index + 1}`}
              >
                <span className="shrink-0 font-medium text-fg-subtle">
                  {preview.visibleIdentityLabel}
                </span>
                <span
                  className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono [unicode-bidi:plaintext]"
                  data-testid={`queue-prompt-identity-${index + 1}`}
                  dir="auto"
                >
                  {preview.visibleIdentity}
                </span>
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      {annotations.length > 0 ? (
        <TimelineAnnotationsChip
          annotations={annotations}
          className={prompt ? "mt-1" : undefined}
        />
      ) : null}
      {content === "unavailable" ? (
        <p
          className="text-og-control leading-5 text-fg-muted italic"
          data-testid={`queue-prompt-unavailable-${index + 1}`}
        >
          {QUEUE_ITEM_CONTENT_UNAVAILABLE}
        </p>
      ) : null}
      {prompt ? (
        <button
          type="button"
          aria-controls={fullContentId}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} full content for queued prompt ${index + 1}`}
          className="mt-1 inline-flex min-h-7 min-w-0 max-w-full items-center gap-1 whitespace-normal rounded-md text-left text-og-xs font-medium text-fg outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-[44px]"
          data-testid={`queue-prompt-disclosure-${index + 1}`}
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            onDisclosureChange(next);
          }}
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-3 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Hide full prompt" : "View full prompt"}
        </button>
      ) : null}
      {expanded && prompt ? (
        <pre
          id={fullContentId}
          role="region"
          aria-label={`Full content for queued prompt ${index + 1}`}
          className="mt-1.5 max-h-64 w-full min-w-0 max-w-full overflow-auto overscroll-contain rounded-md border border-border bg-surface-2/60 p-2 whitespace-pre-wrap break-all font-mono text-og-control leading-5 text-fg [unicode-bidi:plaintext]"
          data-testid={`queue-prompt-full-${index + 1}`}
          dir="auto"
          tabIndex={0}
        >
          {prompt}
        </pre>
      ) : null}
    </div>
  );
}

function ReadOnlyQueueRow({
  turn,
  index,
  attachedInputs,
  onDisclosureChange,
}: {
  turn: SessionTurn;
  index: number;
  attachedInputs: SessionPendingInputPreview[];
  onDisclosureChange: (expanded: boolean) => void;
}) {
  return (
    <li className="flex min-w-0 items-start gap-2 bg-surface px-3 py-2">
      <span className="mt-1 shrink-0 font-mono text-og-xs text-fg-subtle">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <QueuePrompt
          prompt={turn.prompt}
          annotations={turn.annotations ?? []}
          index={index}
          onDisclosureChange={onDisclosureChange}
        />
        {attachedInputs.length > 0 ? (
          <PendingMachineInputs inputs={attachedInputs} attached />
        ) : null}
        <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-og-xs text-fg-subtle">
          {turn.resources.length > 0 ? (
            <span className="shrink-0">
              {turn.resources.length} resource{turn.resources.length === 1 ? "" : "s"}
            </span>
          ) : null}
          {turn.tools.length > 0 ? (
            <span className="shrink-0">
              {turn.tools.length} tool{turn.tools.length === 1 ? "" : "s"}
            </span>
          ) : null}
          <span className="min-w-0 truncate">{modelDisplayName(turn.model)}</span>
          <span className="shrink-0">{turn.reasoningEffort}</span>
        </div>
      </div>
    </li>
  );
}

function SortableQueueRow({
  turn,
  index,
  count,
  attachedInputs,
  pending,
  reorderDisabled,
  confirmingReplace,
  keyboardDragging,
  portalTokenStyle,
  onHandleKeyDown,
  onMove,
  onEdit,
  onConfirmReplace,
  onCancelReplace,
  onSteer,
  onDelete,
  onDisclosureChange,
}: {
  turn: SessionTurn;
  index: number;
  count: number;
  attachedInputs: SessionPendingInputPreview[];
  pending: QueueMutationKind | null;
  reorderDisabled: boolean;
  confirmingReplace: boolean;
  keyboardDragging: boolean;
  portalTokenStyle: PortalTokenStyle;
  onHandleKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onMove: (index: number) => void;
  onEdit?: (() => void) | undefined;
  onConfirmReplace: () => void;
  onCancelReplace: () => void;
  onSteer: () => void;
  onDelete: () => void;
  onDisclosureChange: (expanded: boolean) => void;
}) {
  const sortable = useSortable({
    id: turn.id,
    disabled: reorderDisabled || keyboardDragging,
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
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1.5 px-2 py-1.5 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto] sm:gap-x-2 sm:px-3 sm:py-2">
        <button
          data-queue-handle
          ref={sortable.setActivatorNodeRef}
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          onKeyDown={onHandleKeyDown}
          disabled={reorderDisabled}
          className="col-start-1 row-start-1 mt-0.5 inline-flex size-7 shrink-0 touch-none items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-[44px]"
          aria-label={`Reorder queued prompt ${index + 1}`}
          title="Drag to reorder. Press Space, arrows, then Space to drop."
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        <span className="col-start-2 row-start-1 mt-1 shrink-0 font-mono text-og-xs text-fg-subtle">
          {index + 1}
        </span>
        <div className="col-span-full row-start-2 min-w-0 sm:col-span-1 sm:col-start-3 sm:row-start-1">
          <QueuePrompt
            prompt={turn.prompt}
            annotations={turn.annotations ?? []}
            index={index}
            onDisclosureChange={onDisclosureChange}
          />
          {attachedInputs.length > 0 ? (
            <PendingMachineInputs inputs={attachedInputs} attached />
          ) : null}
          <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-og-xs text-fg-subtle">
            {turn.resources.length > 0 ? (
              <span className="shrink-0">
                {turn.resources.length} resource{turn.resources.length === 1 ? "" : "s"}
              </span>
            ) : null}
            {turn.tools.length > 0 ? (
              <span className="shrink-0">
                {turn.tools.length} tool{turn.tools.length === 1 ? "" : "s"}
              </span>
            ) : null}
            <span className="min-w-0 truncate">{modelDisplayName(turn.model)}</span>
            <span className="shrink-0">{turn.reasoningEffort}</span>
          </div>
          {pending ? (
            <div
              role="status"
              aria-live="polite"
              className="mt-1 flex items-center gap-1.5 text-og-xs font-medium text-status-waiting"
              data-testid={`queue-mutation-${pending}`}
            >
              <Loader2Icon
                aria-hidden="true"
                className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
              />
              {queueMutationPendingLabel(pending)}
            </div>
          ) : null}
        </div>
        <div className="col-span-full row-start-3 flex min-w-0 items-start justify-end gap-1.5 sm:col-span-1 sm:col-start-4 sm:row-start-1 sm:gap-2">
          <button
            type="button"
            disabled={pending !== null}
            onClick={onSteer}
            aria-label={`Steer queued prompt ${index + 1}`}
            data-analytics-action="steer"
            title="Steer — interrupt the current turn and send this message now"
            className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-og-control font-medium text-fg outline-hidden transition-[background-color] hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
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
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-hidden transition-colors hover:bg-surface-2 hover:text-status-failed focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-[44px]"
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
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-hidden transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-[44px]"
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
                collisionPadding={8}
                className={`${MENU_SURFACE_CLASS} og-root z-50 max-h-(--radix-dropdown-menu-content-available-height) w-52 max-w-[calc(100vw-16px)] overflow-x-hidden overflow-y-auto`}
                style={portalTokenStyle}
                data-testid={`queue-actions-menu-${index + 1}`}
              >
                {onEdit ? (
                  <>
                    <DropdownMenu.Item className={QUEUE_MENU_ITEM_CLASS} onSelect={onEdit}>
                      <PencilIcon /> Edit in composer
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
                  </>
                ) : null}
                <DropdownMenu.Item
                  className={QUEUE_MENU_ITEM_CLASS}
                  disabled={index === 0}
                  onSelect={() => onMove(0)}
                >
                  <ArrowUpToLineIcon /> Move to top
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={QUEUE_MENU_ITEM_CLASS}
                  disabled={index === 0}
                  onSelect={() => onMove(index - 1)}
                >
                  Move up
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={QUEUE_MENU_ITEM_CLASS}
                  disabled={index === count - 1}
                  onSelect={() => onMove(index + 1)}
                >
                  Move down
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={QUEUE_MENU_ITEM_CLASS}
                  disabled={index === count - 1}
                  onSelect={() => onMove(count - 1)}
                >
                  <ArrowDownToLineIcon /> Move to bottom
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
      {confirmingReplace ? (
        <div className="mx-3 mb-2 rounded-md border border-status-waiting/30 bg-status-waiting/10 p-2 text-og-control text-fg">
          <p>{QUEUE_REPLACE_DRAFT_COPY.title}</p>
          <p className="mt-0.5 text-fg-muted">{QUEUE_REPLACE_DRAFT_COPY.detail}</p>
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              className="rounded-md px-2 py-1 font-medium hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={onCancelReplace}
            >
              {QUEUE_REPLACE_DRAFT_COPY.keep}
            </button>
            <button
              type="button"
              className="rounded-md border border-og-primary-border bg-og-primary text-og-primary-fg px-2 py-1 font-medium hover:bg-og-primary-hover focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={onConfirmReplace}
            >
              {QUEUE_REPLACE_DRAFT_COPY.replace}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function queueMutationPendingLabel(kind: QueueMutationKind): string {
  switch (kind) {
    case "move":
      return "Saving new position…";
    case "edit":
      return "Moving to composer…";
    case "steer":
      return "Changing direction…";
    case "delete":
      return "Deleting…";
  }
}

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function focusQueueTurn(surface: HTMLElement | null, turnId: string): void {
  window.requestAnimationFrame(() => {
    surface
      ?.querySelector<HTMLElement>(`[data-queue-turn-id="${turnId}"] [data-queue-handle]`)
      ?.focus();
  });
}

function focusAfterQueueRemoval(
  surface: HTMLElement | null,
  previousIndex: number,
  onRequestComposerFocus?: (() => void) | undefined,
): void {
  window.requestAnimationFrame(() => {
    const handles = surface?.querySelectorAll<HTMLElement>("[data-queue-handle]") ?? [];
    const nearest = handles[Math.min(previousIndex, Math.max(0, handles.length - 1))];
    if (nearest) {
      nearest.focus();
      return;
    }
    if (onRequestComposerFocus) {
      onRequestComposerFocus();
      return;
    }
    document
      .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the agent"]')
      ?.focus();
  });
}
