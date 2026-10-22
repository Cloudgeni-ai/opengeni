import type { DraftTimelineAnnotation } from "@opengeni/sdk";
import type { TimelineAnnotationSourceDescriptor } from "./types";

/* ----------------------------------------------------------------------------
   Timeline annotations without the DOM: how a selected quote becomes a draft
   annotation (source offsets and context), shared by the web selection
   popover and native renderers that report a selection as plain text.
   -------------------------------------------------------------------------- */

/** Bytes of source text kept on each side of a quote. */
export const ANNOTATION_SOURCE_CONTEXT_BYTES = 160;
/** Longest quote an annotation may carry. */
export const ANNOTATION_MAX_QUOTE_BYTES = 16 * 1024;
/** Longest note an annotation may carry (characters). */
export const ANNOTATION_MAX_NOTE_LENGTH = 2048;

export function annotationHasNote(note: string): boolean {
  return note.trim().length > 0;
}

export function annotationDisplayOrdinal(
  annotation: { readonly id?: string; readonly ordinal?: number | undefined },
  index: number,
): number {
  return typeof annotation.ordinal === "number" ? annotation.ordinal : index + 1;
}

export function truncateAnnotationQuote(quote: string, maxChars = 160): string {
  const normalized = quote.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function occurrenceOffsets(text: string, quote: string): number[] {
  if (!quote) return [];
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= text.length - quote.length) {
    const offset = text.indexOf(quote, cursor);
    if (offset < 0) break;
    offsets.push(offset);
    cursor = offset + 1;
  }
  return offsets;
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * The part of a rendered selection that appears verbatim in the source text.
 * Rendered text drops markdown syntax, so a selection across formatting falls
 * back to its longest matching prefix, then suffix (at least 8 characters).
 */
export function matchingQuoteInSource(sourceText: string, quote: string): string | null {
  for (const candidate of uniqueNonEmpty([quote, quote.trim()])) {
    if (sourceText.includes(candidate)) return candidate;
  }
  const trimmed = quote.trim();
  for (let length = trimmed.length; length >= 8; length--) {
    const slice = trimmed.slice(0, length);
    if (sourceText.includes(slice)) return slice;
  }
  for (let start = 1; start <= trimmed.length - 8; start++) {
    const slice = trimmed.slice(start);
    if (sourceText.includes(slice)) return slice;
  }
  return null;
}

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function utf8Prefix(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = encoder.encode(character).byteLength;
    if (bytes + next > maxBytes) break;
    output += character;
    bytes += next;
  }
  return output;
}

export function utf8Suffix(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of [...value].reverse()) {
    const next = encoder.encode(character).byteLength;
    if (bytes + next > maxBytes) break;
    output = character + output;
    bytes += next;
  }
  return output;
}

function commonSuffixLength(a: string, b: string): number {
  let count = 0;
  while (
    count < a.length &&
    count < b.length &&
    a[a.length - 1 - count] === b[b.length - 1 - count]
  )
    count++;
  return count;
}

function commonPrefixLength(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count++;
  return count;
}

/**
 * Which occurrence of `quote` in `sourceText` a selection meant, judged by the
 * rendered text around the selection. Markdown syntax breaks exact matches,
 * so the occurrence whose neighbouring characters agree longest wins.
 */
export function bestQuoteOccurrence(
  sourceText: string,
  quote: string,
  offsets: readonly number[],
  textBefore: string,
  textAfter: string,
): number {
  if (offsets.length <= 1) return 0;
  const before = textBefore.slice(-ANNOTATION_SOURCE_CONTEXT_BYTES);
  const after = textAfter.slice(0, ANNOTATION_SOURCE_CONTEXT_BYTES);
  let best = 0;
  let bestScore = -1;
  offsets.forEach((offset, index) => {
    const score =
      commonSuffixLength(before, sourceText.slice(Math.max(0, offset - before.length), offset)) +
      commonPrefixLength(after, sourceText.slice(offset + quote.length));
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

function annotationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export type AnnotationSelection = {
  /** The selected text as rendered. */
  text: string;
  /**
   * Which occurrence of the quote in the source was selected, when the
   * renderer can count it; otherwise the surrounding rendered text decides.
   */
  occurrence?: number | undefined;
  /** Rendered text just before the selection (used when `occurrence` is unknown). */
  textBefore?: string | undefined;
  /** Rendered text just after the selection. */
  textAfter?: string | undefined;
};

/**
 * A draft annotation for a selection inside `source`, or null when nothing
 * selected is in the source text or the quote is empty or too long.
 */
export function annotationFromSelection(
  source: TimelineAnnotationSourceDescriptor,
  selection: AnnotationSelection,
  id: string = annotationId(),
): DraftTimelineAnnotation | null {
  const quote = matchingQuoteInSource(source.text, selection.text) ?? selection.text;
  if (quote.trim().length === 0 || utf8ByteLength(quote) > ANNOTATION_MAX_QUOTE_BYTES) return null;
  const offsets = occurrenceOffsets(source.text, quote);
  if (offsets.length === 0) return null;
  const occurrence =
    selection.occurrence ??
    bestQuoteOccurrence(
      source.text,
      quote,
      offsets,
      selection.textBefore ?? "",
      selection.textAfter ?? "",
    );
  const startOffset = offsets[Math.min(Math.max(0, occurrence), offsets.length - 1)]!;
  const endOffset = startOffset + quote.length;
  return {
    id,
    quote,
    note: "",
    source: {
      kind: source.kind,
      eventId: source.eventId,
      eventType: source.eventType,
      sequence: source.sequence,
      turnId: source.turnId,
      startOffset,
      endOffset,
      contextBefore: utf8Suffix(source.text.slice(0, startOffset), ANNOTATION_SOURCE_CONTEXT_BYTES),
      contextAfter: utf8Prefix(source.text.slice(endOffset), ANNOTATION_SOURCE_CONTEXT_BYTES),
      ...(source.label ? { label: source.label } : {}),
    },
  };
}
