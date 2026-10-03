/**
 * Queue presentation shared by the web queue surface and native docks: the
 * bounded head/tail previews of queued prompts, and the reorder plan and its
 * optimistic projection. No DOM, no React.
 */
import type { SessionQueueSnapshot, SessionTurn } from "@opengeni/sdk";
import { QUEUE_ITEM_CONTENT_UNAVAILABLE, queueItemContent } from "./components/queue-item-content";

export const QUEUE_ROW_PREVIEW_CHARACTERS = 360;
export const QUEUE_COLLAPSED_PREVIEW_CHARACTERS = 180;
const QUEUE_PREVIEW_GRAPHEME_CONTEXT_CHARACTERS = 32;
const QUEUE_PREVIEW_REFERENCE_SAMPLE_CHARACTERS = 32;
const QUEUE_VISIBLE_END_IDENTITY_CHARACTERS = 18;
const QUEUE_PREVIEW_SEPARATOR = " … ";
// Hermes (React Native) has no Intl.Segmenter; there, previews fall back to
// code points, which keeps every boundary rule except grapheme joining.
let queuePreviewSegmenterCache: Intl.Segmenter | null | undefined;
function queuePreviewSegments(sample: string): string[] {
  if (queuePreviewSegmenterCache === undefined) {
    queuePreviewSegmenterCache =
      typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  if (!queuePreviewSegmenterCache) return Array.from(sample);
  return Array.from(queuePreviewSegmenterCache.segment(sample), (part) => part.segment);
}
const queuePromptNonRenderingCodePoint =
  /[\p{White_Space}\p{Control}\p{Default_Ignorable_Code_Point}]/u;

type BoundedPromptSample = {
  value: string;
  characters: number;
  truncated: boolean;
};

export type QueuePromptPreview = {
  summary: string;
  collapsedVisual: string;
  visibleStart: string;
  visibleIdentity: string | null;
  visibleIdentityLabel: "End" | "Safe boundary" | null;
  isFallback: boolean;
};

function labelQueuePreview(summary: string): QueuePromptPreview {
  return {
    summary,
    collapsedVisual: summary,
    visibleStart: summary,
    visibleIdentity: null,
    visibleIdentityLabel: null,
    isFallback: false,
  };
}

export function queueTurnPreview(
  turn: SessionTurn | undefined,
  maxCharacters: number,
): QueuePromptPreview {
  if (!turn) return queuePromptPreview("", maxCharacters);
  return queueContentPreview(turn.prompt, turn.annotations?.length ?? 0, maxCharacters);
}

export function queueContentPreview(
  prompt: string,
  annotationCount: number,
  maxCharacters: number,
): QueuePromptPreview {
  switch (queueItemContent(prompt, annotationCount)) {
    case "text":
      return queuePromptPreview(prompt, maxCharacters);
    case "annotations":
      return labelQueuePreview(
        `${annotationCount} timeline ${annotationCount === 1 ? "annotation" : "annotations"}`,
      );
    case "unavailable":
      return labelQueuePreview(QUEUE_ITEM_CONTENT_UNAVAILABLE);
  }
}

/**
 * Build a bounded head/tail summary of an arbitrary queued prompt. Sampling
 * both ends distinguishes prompts with equal long prefixes. Each sampled edge
 * has a small amount of grapheme context so ordinary emoji/combining sequences
 * can be retained whole. A cluster that exceeds that context is omitted rather
 * than fragmented, and malformed UTF-16 is replaced only in the summary. The
 * durable prompt remains exact and no operation scans or copies it in full.
 */
export function queuePromptPreview(prompt: string, maxCharacters: number): QueuePromptPreview {
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
  return queuePreviewSegments(replaceLoneSurrogates(sample));
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

/** Move one item, as dnd-kit's arrayMove does. */
export function moveQueueItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = items.slice();
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(to < 0 ? next.length + to : to, 0, item);
  return next;
}

export type QueueMovePlan = {
  /** The turn ids in their new order. */
  turnIds: string[];
  /** The server anchor: the turn the moved one now precedes, null for last. */
  beforeTurnId: string | null;
  /** The bounded destination index. */
  index: number;
};

/** The reorder request for moving a queued turn to an index, or null for a no-op. */
export function queueMovePlan(
  queue: readonly SessionTurn[],
  turnId: string,
  nextIndex: number,
): QueueMovePlan | null {
  const oldIndex = queue.findIndex((turn) => turn.id === turnId);
  if (oldIndex < 0) return null;
  const index = Math.max(0, Math.min(nextIndex, queue.length - 1));
  if (oldIndex === index) return null;
  const ordered = moveQueueItem(queue, oldIndex, index);
  return {
    turnIds: ordered.map((turn) => turn.id),
    beforeTurnId: ordered[index + 1]?.id ?? null,
    index,
  };
}

export type PendingQueueMove = { baseVersion: number | null; turnIds: string[] };

/**
 * The queue as shown while a move is in flight: the optimistic order, unless
 * any authoritative change arrived. A projection never omits or invents a row.
 */
export function projectPendingQueueMove(
  queue: SessionTurn[],
  pendingMove: PendingQueueMove | null,
  snapshot: Pick<SessionQueueSnapshot, "version"> | null,
): SessionTurn[] {
  if (
    !pendingMove ||
    pendingMove.baseVersion === null ||
    snapshot?.version !== pendingMove.baseVersion
  ) {
    return queue;
  }
  const byId = new Map(queue.map((turn) => [turn.id, turn]));
  const projected = pendingMove.turnIds.map((turnId) => byId.get(turnId));
  if (projected.some((turn) => !turn) || projected.length !== queue.length) {
    return queue;
  }
  return projected as SessionTurn[];
}

/** Copy for the "replace your draft with this queued prompt" confirmation. */
export const QUEUE_REPLACE_DRAFT_COPY = {
  title: "Your composer already has a draft. Replace it with this queued prompt?",
  detail:
    "The current draft will be permanently discarded; this queued prompt is preserved until you confirm.",
  keep: "Keep current draft",
  replace: "Replace and edit",
} as const;

export type QueuedTurnPresentation = {
  kind: "prompt" | "realtime_voice" | "realtime_voice_handoff";
  text: string;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** What a queued row shows: the prompt, or the transcript of a voice request. */
export function queuedTurnPresentation(turn: SessionTurn): QueuedTurnPresentation {
  const realtimeDelegation = objectValue(turn.metadata.realtimeDelegation);
  const inputTranscript = realtimeDelegation?.inputTranscript;
  if (typeof inputTranscript === "string" && inputTranscript.trim()) {
    return { kind: "realtime_voice", text: inputTranscript.trim() };
  }
  if (objectValue(turn.metadata.realtimeTailFlush)) {
    return { kind: "realtime_voice_handoff", text: "Remaining voice context" };
  }
  return { kind: "prompt", text: turn.prompt };
}

export function isSteeringTurn(turn: SessionTurn): boolean {
  return turn.metadata.delivery === "steer";
}

/** A queued turn that is really waiting: not already a steer in flight. */
export function isAuthoritativeQueuedTurn(
  turn: SessionTurn,
  mutationFor: (turnId: string) => string | null,
): boolean {
  return !isSteeringTurn(turn) && mutationFor(turn.id) !== "steer";
}

export function countAuthoritativeQueuedTurns(
  turns: readonly SessionTurn[],
  mutationFor: (turnId: string) => string | null,
): number {
  return turns.filter((turn) => isAuthoritativeQueuedTurn(turn, mutationFor)).length;
}

/** The move anchors for one row's Move up / Move down. */
export function queueNeighborAnchors(
  turns: readonly SessionTurn[],
  index: number,
): { beforeUp: string | null; beforeDown: string | null } {
  return {
    beforeUp: index > 0 ? (turns[index - 1]?.id ?? null) : null,
    beforeDown: index < turns.length - 1 ? (turns[index + 2]?.id ?? null) : null,
  };
}
