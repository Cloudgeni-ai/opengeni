import {
  DraftTimelineAnnotations,
  SubmittedTimelineAnnotations,
  numberTimelineAnnotations,
  type DraftTimelineAnnotation,
  type SessionEvent,
  type SubmittedTimelineAnnotation,
  type TimelineAnnotation,
} from "@opengeni/contracts";
import { getSessionEvent, type Database } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

const SOURCE_CONTEXT_BYTES = 160;
const ANSI_SEQUENCE = new RegExp("\\u001B\\[[0-?]*[ -/]*[@-~]", "g");

type AnnotationValidationOptions = {
  requireNotes: boolean;
};

function invalidAnnotationSource(): never {
  throw new HTTPException(422, { message: "Invalid timeline annotation source" });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value ?? "");
  }
}

function firstMcpText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const part of value) {
    if (
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      return (part as { text: string }).text;
    }
  }
  return null;
}

function normalizedToolOutput(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined)
    return value == null ? "" : safeJson(value);
  if (typeof value === "string") return value;
  if (typeof value !== "object" || Array.isArray(value)) return safeJson(value);
  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text;
  const contentText = firstMcpText(record.content);
  if (contentText !== null) return contentText;
  if ("structuredContent" in record) {
    return contentText ?? normalizedToolOutput(record.structuredContent, depth + 1);
  }
  if ("result" in record) return normalizedToolOutput(record.result, depth + 1);
  return safeJson(value);
}

function stripExecBanner(text: string): string {
  const marker = text.indexOf("\nOutput:\n");
  if (marker >= 0) return text.slice(marker + "\nOutput:\n".length);
  return text.startsWith("Output:\n") ? text.slice("Output:\n".length) : text;
}

export function timelineAnnotationSourceText(event: SessionEvent): string | null {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "user.message" || event.type === "agent.message.completed") {
    return typeof payload.text === "string" ? payload.text : null;
  }
  if (event.type !== "agent.toolCall.output") return null;
  const output = Object.prototype.hasOwnProperty.call(payload, "output")
    ? payload.output
    : payload.preview;
  const text = stripExecBanner(normalizedToolOutput(output)).replace(ANSI_SEQUENCE, "");
  return text.length > 0 ? text : null;
}

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

function candidateOffsets(sourceText: string, quote: string): number[] {
  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= sourceText.length - quote.length) {
    const index = sourceText.indexOf(quote, cursor);
    if (index < 0) break;
    matches.push(index);
    cursor = index + Math.max(1, quote.length);
  }
  return matches;
}

function resolveQuoteOffset(sourceText: string, annotation: DraftTimelineAnnotation): number {
  const { source, quote } = annotation;
  if (
    source.endOffset - source.startOffset === quote.length &&
    sourceText.slice(source.startOffset, source.endOffset) === quote
  ) {
    return source.startOffset;
  }
  const matches = candidateOffsets(sourceText, quote);
  if (matches.length === 1) return matches[0]!;
  const contextual = matches.filter((start) => {
    const before = sourceText.slice(Math.max(0, start - source.contextBefore.length), start);
    const after = sourceText.slice(
      start + quote.length,
      start + quote.length + source.contextAfter.length,
    );
    return before === source.contextBefore && after === source.contextAfter;
  });
  if (contextual.length === 1) return contextual[0]!;
  return invalidAnnotationSource();
}

async function validateTimelineAnnotations(
  db: Database,
  workspaceId: string,
  sessionId: string,
  annotations: readonly DraftTimelineAnnotation[],
  options: AnnotationValidationOptions,
): Promise<DraftTimelineAnnotation[]> {
  const parsed = options.requireNotes
    ? SubmittedTimelineAnnotations.parse(annotations)
    : DraftTimelineAnnotations.parse(annotations);
  const validated: DraftTimelineAnnotation[] = [];
  for (const annotation of parsed) {
    const event = await getSessionEvent(db, workspaceId, annotation.source.eventId);
    if (
      !event ||
      event.sessionId !== sessionId ||
      event.type !== annotation.source.eventType ||
      event.sequence !== annotation.source.sequence ||
      (event.turnId ?? null) !== annotation.source.turnId
    ) {
      invalidAnnotationSource();
    }
    const sourceText = timelineAnnotationSourceText(event);
    if (sourceText === null) invalidAnnotationSource();
    const startOffset = resolveQuoteOffset(sourceText, annotation);
    const endOffset = startOffset + annotation.quote.length;
    validated.push({
      ...annotation,
      source: {
        ...annotation.source,
        startOffset,
        endOffset,
        contextBefore: utf8Suffix(sourceText.slice(0, startOffset), SOURCE_CONTEXT_BYTES),
        contextAfter: utf8Prefix(sourceText.slice(endOffset), SOURCE_CONTEXT_BYTES),
      },
    });
  }
  return validated;
}

export async function validateDraftTimelineAnnotations(
  db: Database,
  workspaceId: string,
  sessionId: string,
  annotations: readonly DraftTimelineAnnotation[],
): Promise<DraftTimelineAnnotation[]> {
  return await validateTimelineAnnotations(db, workspaceId, sessionId, annotations, {
    requireNotes: false,
  });
}

export async function validateSubmittedTimelineAnnotations(
  db: Database,
  workspaceId: string,
  sessionId: string,
  annotations: readonly SubmittedTimelineAnnotation[],
): Promise<TimelineAnnotation[]> {
  const validated = await validateTimelineAnnotations(db, workspaceId, sessionId, annotations, {
    requireNotes: true,
  });
  return numberTimelineAnnotations(validated as SubmittedTimelineAnnotation[]);
}
