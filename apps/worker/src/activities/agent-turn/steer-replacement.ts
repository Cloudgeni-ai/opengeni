import type { Database } from "@opengeni/db";
import { getSessionTurn } from "@opengeni/db";
import { isModelOrToolProgressHistoryItem } from "./history";

/**
 * A Steer that arrives while a turn is working replaces that turn: the old
 * turn ends `superseded` at its next model step (or at once when it was
 * interrupted or waiting) and the Steer runs as a new turn on the same,
 * unchanged history. That history alone does not say the earlier request was
 * left unfinished: it shows the request, any work done on it, and then the
 * new message, which reads like a change of direction. The general guidance
 * on new messages assumes the earlier work is still in flight, so for a
 * question it says to answer without resuming other work. After a
 * supersession nothing is in flight, and the earlier request would be
 * silently dropped.
 *
 * The replacement turn therefore says so once, in its own turn-scoped notice
 * after the new message. It is a new item, so every earlier request keeps its
 * exact text and cached prefix; it depends only on what happened before it.
 */
export const STEER_REPLACEMENT_NOTE_HEADING = "[Opengeni unfinished earlier request]";

export const STEER_REPLACEMENT_NOTE = [
  STEER_REPLACEMENT_NOTE_HEADING,
  "Your previous turn stopped before it finished, because the newest message above arrived while you were still working on the request before it. Nothing else will continue that request. Unless the newest message cancels or replaces it, answer the newest message and also finish the earlier request in this turn, even when the newest message is only a question.",
].join("\n");

type SteerTurn = {
  source?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
};

/** The turn this Steer replaced, from the Steer's own durable turn record. */
export function steerReplacedTurnId(turn: SteerTurn): string | null {
  if (turn.source === "compaction") return null;
  const metadata = turn.metadata ?? {};
  if (metadata.delivery !== "steer") return null;
  const replaced = metadata.replacedTurnId;
  return typeof replaced === "string" && replaced.length > 0 ? replaced : null;
}

/**
 * The note for a turn that replaced a turn which really ended `superseded`.
 * A Steer deferred to the next model step can find the old turn finishing on
 * its own first; then nothing was left unfinished and there is no note.
 * Optional context: a failed read never fails the turn.
 */
export async function steerReplacementNote(
  db: Database,
  workspaceId: string,
  turn: SteerTurn,
): Promise<string | undefined> {
  const replacedTurnId = steerReplacedTurnId(turn);
  if (!replacedTurnId) return undefined;
  const replaced = await getSessionTurn(db, workspaceId, replacedTurnId).catch(() => null);
  return replaced?.status === "superseded" ? STEER_REPLACEMENT_NOTE : undefined;
}

type StoredTurnRow = { turnId: string | null; item: Record<string, unknown> };

function systemMessageText(item: Record<string, unknown>): string {
  if (item.type !== "message" || item.role !== "system") return "";
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((part: unknown) =>
      part && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}

/**
 * The note belongs to the turn's first model input only. Once the turn has
 * stored model or tool output, or already stored the note (input prepared
 * again for a reply nudge, a compaction retry or a recovery attempt), the
 * model has seen it and it is not repeated.
 */
export function steerReplacementNoteDue(rows: readonly StoredTurnRow[], turnId: string): boolean {
  return !rows.some(
    (row) =>
      row.turnId === turnId &&
      (isModelOrToolProgressHistoryItem(row.item) ||
        systemMessageText(row.item).includes(STEER_REPLACEMENT_NOTE_HEADING)),
  );
}
