import type { TimelineAnnotationSource } from "@opengeni/sdk";

export function annotationHasNote(note: string): boolean {
  return note.trim().length > 0;
}

export function annotationDisplayOrdinal(
  annotation: { ordinal?: number | undefined },
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
