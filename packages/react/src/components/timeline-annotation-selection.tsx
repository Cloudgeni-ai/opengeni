import type { DraftTimelineAnnotation } from "@opengeni/sdk";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { TimelineAnnotationSourceDescriptor } from "../timeline";

type SelectionCandidate = {
  annotation: DraftTimelineAnnotation;
  left: number;
  top: number;
  keyboard: boolean;
};

const INTERACTIVE_SELECTOR =
  'a,button,input,textarea,select,summary,[role="button"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
const SOURCE_CONTEXT_BYTES = 160;
const MAX_QUOTE_BYTES = 16 * 1024;

function utf8Prefix(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = new TextEncoder().encode(character).byteLength;
    if (bytes + next > maxBytes) break;
    output += character;
    bytes += next;
  }
  return output;
}

function utf8Suffix(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of [...value].reverse()) {
    const next = new TextEncoder().encode(character).byteLength;
    if (bytes + next > maxBytes) break;
    output = character + output;
    bytes += next;
  }
  return output;
}

function selectionElement(node: Node | null): Element | null {
  return node instanceof Element ? node : (node?.parentElement ?? null);
}

function containingSource(node: Node | null): HTMLElement | null {
  const element = selectionElement(node);
  const source = element?.closest("[data-og-annotation-source-key]");
  return source instanceof HTMLElement ? source : null;
}

function isInteractiveSelection(node: Node | null, boundary: HTMLElement): boolean {
  const element = selectionElement(node);
  const interactive = element?.closest(INTERACTIVE_SELECTOR);
  return interactive instanceof Element && boundary.contains(interactive);
}

function occurrenceOffsets(text: string, quote: string): number[] {
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

function selectedOccurrence(boundary: HTMLElement, range: Range, quote: string): number {
  try {
    const prefix = range.cloneRange();
    prefix.selectNodeContents(boundary);
    prefix.setEnd(range.startContainer, range.startOffset);
    return occurrenceOffsets(prefix.toString(), quote).length;
  } catch {
    return 0;
  }
}

function annotationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildCandidate(
  root: HTMLElement,
  sources: ReadonlyMap<string, TimelineAnnotationSourceDescriptor>,
  keyboard: boolean,
): SelectionCandidate | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startBoundary = containingSource(range.startContainer);
  const endBoundary = containingSource(range.endContainer);
  if (!startBoundary || startBoundary !== endBoundary || !root.contains(startBoundary)) return null;
  if (
    isInteractiveSelection(range.startContainer, startBoundary) ||
    isInteractiveSelection(range.endContainer, startBoundary)
  ) {
    return null;
  }
  const sourceKey = startBoundary.dataset.ogAnnotationSourceKey;
  const source = sourceKey ? sources.get(sourceKey) : undefined;
  const quote = selection.toString();
  if (
    !source ||
    quote.trim().length === 0 ||
    new TextEncoder().encode(quote).byteLength > MAX_QUOTE_BYTES
  ) {
    return null;
  }
  const sourceOffsets = occurrenceOffsets(source.text, quote);
  if (sourceOffsets.length === 0) return null;
  const occurrence = selectedOccurrence(startBoundary, range, quote);
  const startOffset = sourceOffsets[Math.min(occurrence, sourceOffsets.length - 1)]!;
  const endOffset = startOffset + quote.length;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    annotation: {
      id: annotationId(),
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
        contextBefore: utf8Suffix(source.text.slice(0, startOffset), SOURCE_CONTEXT_BYTES),
        contextAfter: utf8Prefix(source.text.slice(endOffset), SOURCE_CONTEXT_BYTES),
        ...(source.label ? { label: source.label } : {}),
      },
    },
    left: Math.min(Math.max(12, rect.left + rect.width / 2), window.innerWidth - 12),
    top: rect.bottom + 48 <= window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - 40),
    keyboard,
  };
}

export function TimelineAnnotationSelection({
  rootRef,
  sources,
  onAnnotate,
}: {
  rootRef: RefObject<HTMLElement | null>;
  sources: ReadonlyMap<string, TimelineAnnotationSourceDescriptor>;
  onAnnotate?: ((annotation: DraftTimelineAnnotation) => void) | undefined;
}) {
  const [candidate, setCandidate] = useState<SelectionCandidate | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onAnnotate) {
      setCandidate(null);
      return;
    }
    const update = (keyboard: boolean) => {
      setCandidate(buildCandidate(root, sources, keyboard));
    };
    const onPointerUp = () => window.setTimeout(() => update(false), 0);
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCandidate(null);
        return;
      }
      window.setTimeout(() => update(true), 0);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        candidate &&
        !(event.target instanceof Node && buttonRef.current?.contains(event.target))
      ) {
        setCandidate(null);
      }
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCandidate(null);
    };
    root.addEventListener("pointerup", onPointerUp);
    root.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [candidate, onAnnotate, rootRef, sources]);

  useEffect(() => {
    if (candidate?.keyboard) buttonRef.current?.focus();
  }, [candidate]);

  if (!candidate || !onAnnotate || typeof document === "undefined") return null;
  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      style={{ left: candidate.left, top: candidate.top }}
      className="og-root fixed z-[80] -translate-x-1/2 rounded-full border border-og-border bg-og-surface-1 px-3 py-1.5 text-og-sm font-medium text-og-fg shadow-lg outline-hidden transition hover:bg-og-surface-2 focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]"
      onClick={() => {
        onAnnotate(candidate.annotation);
        document.getSelection()?.removeAllRanges();
        setCandidate(null);
      }}
    >
      Annotate
    </button>,
    document.body,
  );
}

export default TimelineAnnotationSelection;
