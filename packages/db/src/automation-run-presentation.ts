import { SessionSystemUpdatePayload } from "@opengeni/contracts";

const MAX_EVENT_SUMMARIES = 3;
const MAX_EVENT_SUMMARY_BYTES = 200;

/** What a chat shows for an automation run. Never its instructions. */
export type AutomationRunPresentation = {
  /** The automation's name (the update's summary). */
  name: string;
  /** What the first few events that started the run say, oldest first. */
  eventSummaries: string[];
  /** How many events started the run; 0 for a scheduled run. */
  eventCount: number;
};

/**
 * The plain description a delivered `scheduled_occurrence` update carries to
 * the chat: the automation's name and what the events that started it say
 * happened. An update written while its summary still repeated the
 * instructions gets none, so the chat falls back to its plain default rather
 * than showing them.
 */
export function automationRunPresentation(update: {
  kind: string;
  summary: string;
  payload: unknown;
}): AutomationRunPresentation | null {
  if (update.kind !== "scheduled_occurrence") return null;
  const parsed = SessionSystemUpdatePayload.safeParse(update.payload);
  if (!parsed.success || parsed.data.type !== "scheduled_occurrence") return null;
  const name = boundedUtf8(update.summary.replace(/\s+/g, " ").trim(), 512);
  if (!name || update.summary === parsed.data.text) return null;
  const events = parsed.data.events;
  return {
    name,
    eventSummaries: (events?.events ?? [])
      .map((event) => event.summary.replace(/\s+/g, " ").trim())
      .filter((text) => text.length > 0)
      .slice(0, MAX_EVENT_SUMMARIES)
      .map((text) => boundedUtf8(text, MAX_EVENT_SUMMARY_BYTES)),
    eventCount: events?.eventCount ?? 0,
  };
}

function boundedUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const suffix = "…";
  let cut = Buffer.from(text)
    .subarray(0, maxBytes - Buffer.byteLength(suffix))
    .toString("utf8");
  if (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  return `${cut}${suffix}`;
}
