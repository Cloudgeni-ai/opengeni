import type { TimelineAnnotationSource } from "@opengeni/sdk";

export const ANNOTATION_CHROME_SELECTOR =
  "[data-og-annotation-chrome], [data-og-annotation-badge], [data-og-annotation-popover]";

export function annotationHasNote(note: string): boolean {
  return note.trim().length > 0;
}

export function annotationDisplayOrdinal(
  annotation: { readonly id?: string; readonly ordinal?: number | undefined },
  index: number,
): number {
  return typeof annotation.ordinal === "number" ? annotation.ordinal : index + 1;
}

export function sourceKindLabel(kind: TimelineAnnotationSource["kind"]): string {
  switch (kind) {
    case "user_message":
      return "Your message";
    case "assistant_message":
      return "Assistant";
    case "tool_output":
      return "Tool output";
  }
}

export function annotationSourceLabel(source: TimelineAnnotationSource): string {
  return source.label?.trim() || sourceKindLabel(source.kind);
}

export function truncateAnnotationQuote(quote: string, maxChars = 160): string {
  const normalized = quote.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function cssEscapeAttribute(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function isAnnotationChromeNode(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element?.closest(ANNOTATION_CHROME_SELECTOR));
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

type AnnotatableSpan = {
  node: Text;
  start: number;
  length: number;
};

export function annotatableText(root: HTMLElement): { text: string; spans: AnnotatableSpan[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || node.data.length === 0) return NodeFilter.FILTER_REJECT;
      if (isAnnotationChromeNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const spans: AnnotatableSpan[] = [];
  let text = "";
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (!(current instanceof Text)) continue;
    spans.push({ node: current, start: text.length, length: current.data.length });
    text += current.data;
  }
  return { text, spans };
}

function pointAt(
  spans: AnnotatableSpan[],
  offset: number,
  stickEnd: boolean,
): { node: Text; offset: number } | null {
  if (spans.length === 0) return null;
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index]!;
    const local = offset - span.start;
    if (local < 0) continue;
    if (local < span.length || (local === span.length && (stickEnd || index === spans.length - 1))) {
      return { node: span.node, offset: local };
    }
  }
  const last = spans[spans.length - 1]!;
  return { node: last.node, offset: last.length };
}

export function rangeFromOffsets(
  spans: AnnotatableSpan[],
  startOffset: number,
  endOffset: number,
): Range | null {
  const start = pointAt(spans, startOffset, false);
  const end = pointAt(spans, endOffset, true);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range.collapsed ? null : range;
}

export function buildQuoteRange(
  sourceEl: HTMLElement,
  quote: string,
  occurrenceIndex = 0,
): Range | null {
  if (!quote) return null;
  const { text, spans } = annotatableText(sourceEl);
  const offsets = occurrenceOffsets(text, quote);
  if (offsets.length === 0) return null;
  const start = offsets[Math.min(Math.max(0, occurrenceIndex), offsets.length - 1)]!;
  return rangeFromOffsets(spans, start, start + quote.length);
}

export function quoteOccurrenceIndex(sourceEl: HTMLElement, range: Range, quote: string): number {
  try {
    const prefix = range.cloneRange();
    prefix.selectNodeContents(sourceEl);
    prefix.setEnd(range.startContainer, range.startOffset);
    return occurrenceOffsets(prefix.toString(), quote).length;
  } catch {
    return 0;
  }
}

export function clipRangeToSource(range: Range, sourceEl: HTMLElement): Range | null {
  const startOk =
    sourceEl.contains(range.startContainer) && !isAnnotationChromeNode(range.startContainer);
  const endOk =
    sourceEl.contains(range.endContainer) && !isAnnotationChromeNode(range.endContainer);
  if (!startOk && !endOk) return null;
  const { spans } = annotatableText(sourceEl);
  if (spans.length === 0) return null;
  const next = range.cloneRange();
  const first = spans[0]!;
  const last = spans[spans.length - 1]!;
  if (!startOk) next.setStart(first.node, 0);
  if (!endOk) next.setEnd(last.node, last.node.data.length);
  return next.collapsed ? null : next;
}

export function visibleClientRect(range: Range): DOMRect | null {
  try {
    const bounding = range.getBoundingClientRect();
    if (bounding.width > 0 || bounding.height > 0) return bounding;
  } catch {
    // jsdom ranges may omit layout geometry.
  }
  try {
    const rects = range.getClientRects();
    for (let index = 0; index < rects.length; index++) {
      const rect = rects.item(index);
      if (rect && (rect.width > 0 || rect.height > 0)) return rect;
    }
  } catch {
    // jsdom ranges may omit client rects.
  }
  return null;
}

export function revealLoadedAnnotationSource(source: TimelineAnnotationSource): boolean {
  if (typeof document === "undefined") return false;
  const element = document.querySelector(
    `[data-og-annotation-source-key="${cssEscapeAttribute(source.eventId)}"]`,
  );
  if (!(element instanceof HTMLElement)) return false;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.animate?.(
    [
      {
        boxShadow: "inset 0 0 0 2px color-mix(in oklch, var(--og-accent) 70%, transparent)",
        backgroundColor: "color-mix(in oklch, var(--og-accent) 14%, transparent)",
      },
      {
        boxShadow: "inset 0 0 0 2px transparent",
        backgroundColor: "transparent",
      },
    ],
    { duration: 1400, easing: "ease-out" },
  );
  return true;
}
