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
import {
  useCallback,
  useId,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

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
  const collapsedPreview = useMemo(
    () => queuePromptPreview(queue.queue[0]?.prompt ?? "", QUEUE_COLLAPSED_PREVIEW_CHARACTERS),
    [queue.queue],
  );
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
      const draftDirty =
        composer.value.length > 0 ||
        composer.restoredResources.length > 0 ||
        (composer.draft?.tools.length ?? 0) > 0 ||
        (composer.draft?.sourceTurnId !== null && composer.draft?.sourceTurnId !== undefined);
      if (draftDirty) {
        setReplaceDraftFor(turn.id);
      } else {
        void edit(turn, false);
      }
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
          className="flex w-full min-w-0 flex-wrap items-center gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 pointer-coarse:min-h-[44px]"
          onClick={() => setOpen((value) => !value)}
          aria-description={!open && count > 0 ? collapsedPreview.summary : undefined}
          aria-expanded={open}
          aria-label={`${count} queued prompt${count === 1 ? "" : "s"}${readOnly ? " Read-only" : ""}`}
        >
          <ChevronDownIcon
            aria-hidden="true"
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
            <span
              aria-hidden="true"
              className={`max-w-full truncate text-fg-muted ${
                collapsedPreview.collapsedVisual === collapsedPreview.summary
                  ? "min-w-0 flex-1 text-xs"
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
                  className="max-h-20 w-[min(36rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-brand/40 bg-surface px-3 py-2 text-xs text-fg shadow-lg"
                  data-testid="queue-drag-overlay"
                >
                  <p
                    aria-hidden="true"
                    className="line-clamp-3 break-all whitespace-pre-wrap [unicode-bidi:plaintext]"
                    dir="auto"
                  >
                    {
                      queuePromptPreview(
                        queue.queue.find((turn) => turn.id === draggedTurnId)?.prompt ?? "",
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
          <div className="border-t border-border p-2">
            <div
              role="alert"
              className="flex min-w-0 max-w-full flex-wrap items-start gap-2 rounded-md bg-status-failed/10 px-2 py-1.5 text-xs text-status-failed"
            >
              <span
                role="region"
                aria-label="Queue error details"
                tabIndex={0}
                className="max-h-[min(5rem,20dvh)] min-w-0 max-w-full flex-[1_1_5rem] overflow-auto overscroll-contain whitespace-pre-wrap rounded-sm outline-none [overflow-wrap:anywhere] [unicode-bidi:plaintext] focus-visible:ring-2 focus-visible:ring-ring/40"
                data-testid="queue-error-message"
                dir="auto"
              >
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
                className="ms-auto inline-flex size-7 shrink-0 items-center justify-center self-start rounded-md outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none pointer-coarse:size-[44px]"
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

const QUEUE_ROW_PREVIEW_CHARACTERS = 360;
const QUEUE_COLLAPSED_PREVIEW_CHARACTERS = 180;
const QUEUE_PREVIEW_GRAPHEME_CONTEXT_CHARACTERS = 32;
const QUEUE_PREVIEW_REFERENCE_SAMPLE_CHARACTERS = 32;
const QUEUE_VISIBLE_END_IDENTITY_CHARACTERS = 18;
const QUEUE_PREVIEW_SEPARATOR = " … ";
const queuePreviewSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const queuePromptNonRenderingCodePoint =
  /[\p{White_Space}\p{Control}\p{Default_Ignorable_Code_Point}]/u;

type BoundedPromptSample = {
  value: string;
  characters: number;
  truncated: boolean;
};

type QueuePromptPreview = {
  summary: string;
  collapsedVisual: string;
  visibleStart: string;
  visibleIdentity: string | null;
  visibleIdentityLabel: "End" | "Safe boundary" | null;
  isFallback: boolean;
};

/**
 * Build a bounded head/tail summary of an arbitrary queued prompt. Sampling
 * both ends distinguishes prompts with equal long prefixes. Each sampled edge
 * has a small amount of grapheme context so ordinary emoji/combining sequences
 * can be retained whole. A cluster that exceeds that context is omitted rather
 * than fragmented, and malformed UTF-16 is replaced only in the summary. The
 * durable prompt remains exact and no operation scans or copies it in full.
 */
function queuePromptPreview(prompt: string, maxCharacters: number): QueuePromptPreview {
  const wholePromptProbe = samplePromptStart(prompt, maxCharacters + 1);
  if (!wholePromptProbe.truncated && wholePromptProbe.characters <= maxCharacters) {
    const summary = replaceLoneSurrogates(wholePromptProbe.value);
    return hasVisiblePromptContent(summary)
      ? {
          summary,
          collapsedVisual: summary,
          visibleStart: summary,
          visibleIdentity: null,
          visibleIdentityLabel: null,
          isFallback: false,
        }
      : fallbackPromptPreview(prompt.length, wholePromptProbe.value, wholePromptProbe.value);
  }

  const suffixCharacters = Math.min(Math.floor(maxCharacters / 3), 120);
  const prefixCharacters =
    maxCharacters - codePointLength(QUEUE_PREVIEW_SEPARATOR) - suffixCharacters;
  const prefixSample = samplePromptStart(
    prompt,
    prefixCharacters + QUEUE_PREVIEW_GRAPHEME_CONTEXT_CHARACTERS,
  );
  const suffixSample = samplePromptEnd(
    prompt,
    suffixCharacters + QUEUE_PREVIEW_GRAPHEME_CONTEXT_CHARACTERS,
  );
  const prefixSegments = segmentPromptSample(prefixSample.value);
  const suffixSegments = segmentPromptSample(suffixSample.value);

  // A cluster at a truncated sampling edge may continue outside the sample.
  // Prefix sampling starts at the true source start, so only its last segment
  // is ambiguous. Suffix sampling ends at the true source end, so its first is.
  if (prefixSample.truncated) prefixSegments.pop();
  if (suffixSample.truncated) {
    let ambiguousSegment = suffixSegments.shift();
    // A locally segmented leading fragment ending in ZWJ can join the next
    // pictographic segment when omitted left context supplies its base. Keep
    // backing off until that uncertainty no longer propagates to the right.
    while (ambiguousSegment?.endsWith("\u200d") && suffixSegments.length > 0) {
      ambiguousSegment = suffixSegments.shift();
    }
    // Regional Indicator pairing depends on the parity of the preceding run.
    // If that run reaches the unknown sample boundary, omit all of its visible
    // leading segments rather than potentially recombining halves of flags.
    while (suffixSegments[0] && startsWithRegionalIndicator(suffixSegments[0])) {
      suffixSegments.shift();
    }
  }

  const prefix = takeWholeGraphemesFromStart(prefixSegments, prefixCharacters);
  const suffix = takeWholeGraphemesFromEnd(suffixSegments, suffixCharacters);
  const reference = boundedPromptSampleReference(
    prompt.length,
    prefixSample.value,
    suffixSample.value,
  );

  if (!hasVisiblePromptContent(prefix) && !hasVisiblePromptContent(suffix)) {
    return fallbackPromptPreview(prompt.length, prefixSample.value, suffixSample.value);
  }

  const safeSuffix = hasVisiblePromptContent(suffix)
    ? suffix
    : promptPreviewFallbackLabel(reference);
  const summary = `${prefix}${QUEUE_PREVIEW_SEPARATOR}${safeSuffix}`;
  if (!hasVisiblePromptContent(prefix)) {
    return {
      summary,
      collapsedVisual: summary,
      visibleStart: safeSuffix,
      visibleIdentity: null,
      visibleIdentityLabel: null,
      isFallback: false,
    };
  }

  const endIdentity = takeWholeGraphemesFromEnd(
    suffixSegments,
    QUEUE_VISIBLE_END_IDENTITY_CHARACTERS,
  );
  return {
    summary,
    collapsedVisual: summary,
    visibleStart: prefix,
    visibleIdentity: hasVisiblePromptContent(endIdentity) ? endIdentity : `ref ${reference}`,
    visibleIdentityLabel: hasVisiblePromptContent(endIdentity) ? "End" : "Safe boundary",
    isFallback: false,
  };
}

function fallbackPromptPreview(
  promptLength: number,
  startSample: string,
  endSample: string,
): QueuePromptPreview {
  const reference = boundedPromptSampleReference(promptLength, startSample, endSample);
  const summary = promptPreviewFallbackLabel(reference);
  return {
    summary,
    collapsedVisual: `Omitted · ${reference}`,
    // The complete fallback remains the canonical accessible summary. Narrow
    // collapsed/row layouts paint the bounded reference in a compact truthful
    // form so ellipsis cannot hide the only identifying portion.
    visibleStart: `Omitted · ${reference}`,
    visibleIdentity: null,
    visibleIdentityLabel: null,
    isFallback: true,
  };
}

function promptPreviewFallbackLabel(reference: string): string {
  return `Content omitted at safe boundary · ref ${reference}`;
}

function boundedPromptSampleReference(
  promptLength: number,
  startSample: string,
  endSample: string,
): string {
  const head = samplePromptStart(startSample, QUEUE_PREVIEW_REFERENCE_SAMPLE_CHARACTERS).value;
  const tail = samplePromptEnd(endSample, QUEUE_PREVIEW_REFERENCE_SAMPLE_CHARACTERS).value;
  let hash = 0x811c9dc5;
  for (const value of [String(promptLength), head, tail]) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xffff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

function hasVisiblePromptContent(value: string): boolean {
  // Callers pass only the already-bounded whole/head/tail preview samples.
  // Default-ignorables and controls can survive trim() while painting no row
  // identity at all (for example ZWJ, VS16, bidi controls, and tag characters).
  for (const character of value) {
    if (!queuePromptNonRenderingCodePoint.test(character)) return true;
  }
  return false;
}

function samplePromptStart(prompt: string, maxCharacters: number): BoundedPromptSample {
  let end = 0;
  let characters = 0;
  while (end < prompt.length && characters < maxCharacters) {
    const first = prompt.charCodeAt(end);
    end +=
      isHighSurrogate(first) &&
      end + 1 < prompt.length &&
      isLowSurrogate(prompt.charCodeAt(end + 1))
        ? 2
        : 1;
    characters += 1;
  }
  return { value: prompt.slice(0, end), characters, truncated: end < prompt.length };
}

function samplePromptEnd(prompt: string, maxCharacters: number): BoundedPromptSample {
  let start = prompt.length;
  let characters = 0;
  while (start > 0 && characters < maxCharacters) {
    start -= 1;
    if (
      isLowSurrogate(prompt.charCodeAt(start)) &&
      start > 0 &&
      isHighSurrogate(prompt.charCodeAt(start - 1))
    ) {
      start -= 1;
    }
    characters += 1;
  }
  return { value: prompt.slice(start), characters, truncated: start > 0 };
}

function segmentPromptSample(sample: string): string[] {
  return Array.from(
    queuePreviewSegmenter.segment(replaceLoneSurrogates(sample)),
    ({ segment }) => segment,
  );
}

function replaceLoneSurrogates(value: string): string {
  let sanitized = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (
      isHighSurrogate(current) &&
      index + 1 < value.length &&
      isLowSurrogate(value.charCodeAt(index + 1))
    ) {
      sanitized += value.slice(index, index + 2);
      index += 1;
    } else if (isHighSurrogate(current) || isLowSurrogate(current)) {
      sanitized += "�";
    } else {
      sanitized += value[index];
    }
  }
  return sanitized;
}

function takeWholeGraphemesFromStart(segments: string[], maxCharacters: number): string {
  const selected: string[] = [];
  let characters = 0;
  for (const segment of segments) {
    const segmentCharacters = codePointLength(segment);
    if (characters + segmentCharacters > maxCharacters) break;
    selected.push(segment);
    characters += segmentCharacters;
  }
  while (selected.at(-1)?.trim().length === 0) selected.pop();
  return selected.join("");
}

function takeWholeGraphemesFromEnd(segments: string[], maxCharacters: number): string {
  const selected: string[] = [];
  let characters = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!segment) continue;
    const segmentCharacters = codePointLength(segment);
    if (characters + segmentCharacters > maxCharacters) break;
    selected.unshift(segment);
    characters += segmentCharacters;
  }
  while (selected[0]?.trim().length === 0) selected.shift();
  while (selected.at(-1)?.trim().length === 0) selected.pop();
  return selected.join("");
}

function codePointLength(value: string): number {
  let characters = 0;
  for (const _character of value) characters += 1;
  return characters;
}

function startsWithRegionalIndicator(value: string): boolean {
  const codePoint = value.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function QueuePrompt({
  prompt,
  index,
  onDisclosureChange,
}: {
  prompt: string;
  index: number;
  onDisclosureChange: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const fullContentId = useId();
  const preview = useMemo(() => queuePromptPreview(prompt, QUEUE_ROW_PREVIEW_CHARACTERS), [prompt]);

  return (
    <div className="w-full min-w-0 max-w-full">
      <div
        aria-label={`Queued prompt ${index + 1} summary: ${preview.summary}`}
        className="max-w-full overflow-hidden text-xs leading-5 text-fg"
        data-testid={`queue-prompt-preview-${index + 1}`}
        dir="auto"
        role="note"
      >
        <span aria-hidden="true" className="flex min-w-0 max-w-full items-baseline gap-2 sm:block">
          <span
            className={`${preview.isFallback ? "" : "line-clamp-1 sm:line-clamp-2"} min-w-0 flex-1 whitespace-pre-wrap break-all [unicode-bidi:plaintext]`}
            data-testid={`queue-prompt-start-${index + 1}`}
            dir="auto"
          >
            {preview.visibleStart}
          </span>
          {preview.visibleIdentity && preview.visibleIdentityLabel ? (
            <span
              className="flex min-w-0 max-w-[70%] shrink-0 items-center gap-1 text-2xs leading-4 text-fg-muted sm:mt-0.5 sm:max-w-full"
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
      <button
        type="button"
        aria-controls={fullContentId}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} full content for queued prompt ${index + 1}`}
        className="mt-1 inline-flex min-h-7 min-w-0 max-w-full items-center gap-1 whitespace-normal rounded-md text-left text-2xs font-medium text-fg-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:min-h-[44px]"
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
      {expanded ? (
        <pre
          id={fullContentId}
          role="region"
          aria-label={`Full content for queued prompt ${index + 1}`}
          className="mt-1.5 max-h-64 w-full min-w-0 max-w-full overflow-auto overscroll-contain rounded-md border border-border bg-surface-2/60 p-2 whitespace-pre-wrap break-all font-mono text-xs leading-5 text-fg [unicode-bidi:plaintext]"
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
  onDisclosureChange,
}: {
  turn: SessionTurn;
  index: number;
  onDisclosureChange: (expanded: boolean) => void;
}) {
  return (
    <li className="flex min-w-0 items-start gap-2 bg-surface px-3 py-2">
      <span className="mt-1 shrink-0 font-mono text-2xs text-fg-subtle">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <QueuePrompt prompt={turn.prompt} index={index} onDisclosureChange={onDisclosureChange} />
        <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-2xs text-fg-subtle">
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
          <span className="min-w-0 truncate">{turn.model}</span>
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
  onDisclosureChange,
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
  onDisclosureChange: (expanded: boolean) => void;
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
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1.5 px-2 py-1.5 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto] sm:gap-x-2 sm:px-3 sm:py-2">
        <button
          data-queue-handle
          ref={sortable.setActivatorNodeRef}
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          onKeyDown={onHandleKeyDown}
          disabled={pending !== null}
          className="col-start-1 row-start-1 mt-0.5 inline-flex size-7 shrink-0 touch-none items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-[44px]"
          aria-label={`Reorder queued prompt ${index + 1}`}
          title="Drag to reorder. Press Space, arrows, then Space to drop."
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        <span className="col-start-2 row-start-1 mt-1 shrink-0 font-mono text-2xs text-fg-subtle">
          {index + 1}
        </span>
        <div className="col-span-full row-start-2 min-w-0 sm:col-span-1 sm:col-start-3 sm:row-start-1">
          <QueuePrompt prompt={turn.prompt} index={index} onDisclosureChange={onDisclosureChange} />
          <div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-2xs text-fg-subtle">
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
            <span className="min-w-0 truncate">{turn.model}</span>
            <span className="shrink-0">{turn.reasoningEffort}</span>
          </div>
        </div>
        <div className="col-span-full row-start-3 flex min-w-0 items-start justify-end gap-1.5 sm:col-span-1 sm:col-start-4 sm:row-start-1 sm:gap-2">
          <button
            type="button"
            disabled={pending !== null}
            onClick={onSteer}
            aria-label={`Steer queued prompt ${index + 1}`}
            title="Make this the next direction"
            className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
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
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-surface-2 hover:text-status-failed focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-[44px]"
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
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-[44px]"
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
                className="z-50 w-48 max-w-[calc(100vw-16px)] rounded-md border border-border bg-surface p-1 text-xs text-fg shadow-lg"
                data-testid={`queue-actions-menu-${index + 1}`}
              >
                <DropdownMenu.Item
                  className="flex min-w-0 cursor-default items-center gap-2 whitespace-normal break-words rounded-sm px-2 py-1.5 outline-none focus:bg-surface-2 pointer-coarse:min-h-[44px]"
                  onSelect={onEdit}
                >
                  <PencilIcon className="size-3.5" /> Edit in composer
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  className="flex min-w-0 cursor-default items-center gap-2 whitespace-normal break-words rounded-sm px-2 py-1.5 outline-none focus:bg-surface-2 data-[disabled]:opacity-50 pointer-coarse:min-h-[44px]"
                  disabled={index === 0}
                  onSelect={() => onMove(0)}
                >
                  <ArrowUpToLineIcon className="size-3.5" /> Move to top
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="flex min-w-0 cursor-default items-center gap-2 whitespace-normal break-words rounded-sm px-2 py-1.5 outline-none focus:bg-surface-2 data-[disabled]:opacity-50 pointer-coarse:min-h-[44px]"
                  disabled={index === 0}
                  onSelect={() => onMove(index - 1)}
                >
                  Move up
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="flex min-w-0 cursor-default items-center gap-2 whitespace-normal break-words rounded-sm px-2 py-1.5 outline-none focus:bg-surface-2 data-[disabled]:opacity-50 pointer-coarse:min-h-[44px]"
                  disabled={index === count - 1}
                  onSelect={() => onMove(index + 1)}
                >
                  Move down
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="flex min-w-0 cursor-default items-center gap-2 whitespace-normal break-words rounded-sm px-2 py-1.5 outline-none focus:bg-surface-2 data-[disabled]:opacity-50 pointer-coarse:min-h-[44px]"
                  disabled={index === count - 1}
                  onSelect={() => onMove(count - 1)}
                >
                  <ArrowDownToLineIcon className="size-3.5" /> Move to bottom
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
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
