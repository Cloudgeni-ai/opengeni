import { createHash } from "node:crypto";
import {
  freezeAgentLearningPolicy,
  getKnowledgeEntry,
  getSessionEvent,
  getSessionTurn,
  nestedPostgresSqlState,
  saveKnowledgeEntry,
  type Database,
  type KnowledgeContext,
} from "@opengeni/db";

function stableId(value: string) {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Retain actual message bytes, never a model-authored reconstruction of a confirmation. */
export async function retainKnowledgeMessage(
  db: Database,
  context: KnowledgeContext,
  messageId?: string,
) {
  if (context.actor.kind !== "agent") throw new Error("An exact agent attempt is required");
  // Validates the live attempt and resolves its frozen personal/shared authoring scope.
  const policy = await freezeAgentLearningPolicy(db, context);
  const turn = await getSessionTurn(db, context.workspaceId, context.actor.turnId);
  if (!turn || turn.sessionId !== context.actor.sessionId) throw new Error("Message unavailable");
  const eventId = messageId ?? turn.triggerEventId;
  const event = eventId ? await getSessionEvent(db, context.workspaceId, eventId) : null;
  const payload = event?.payload;
  const text =
    payload && typeof payload === "object" && "text" in payload ? payload.text : undefined;
  if (
    !event ||
    event.sessionId !== context.actor.sessionId ||
    event.type !== "user.message" ||
    typeof text !== "string" ||
    !text.trim()
  ) {
    return {
      retained: false,
      reason:
        "Choose a user message from this conversation. The current turn may have been triggered by a tool or scheduled event.",
    };
  }
  const key = `${context.accountId}:${context.workspaceId}:${policy.defaultScope}:${policy.subjectId ?? ""}:${event.id}`;
  const entryId = stableId(`knowledge-message:${key}`);
  for (const view of ["published", "needs_review"] as const) {
    const existing = await getKnowledgeEntry(db, context, entryId, { view });
    if (!existing) continue;
    if (
      existing.archived ||
      existing.revision.outcome === "rejected" ||
      existing.revision.entry.content !== text
    ) {
      return {
        retained: false,
        reason:
          "This retained message was edited, archived or rejected. Inspect its history; it has not been overwritten or revived.",
        entryId,
      };
    }
    return {
      retained: true,
      entryId,
      revisionId: existing.revision.id,
      outcome: existing.revision.outcome,
      messageId: event.id,
      reused: true,
    };
  }
  let receipt;
  try {
    receipt = await saveKnowledgeEntry(db, context, {
      operationId: crypto.randomUUID(),
      entryId,
      expectedVersion: 0,
      entry: {
        kind: "source",
        title: `Chat: ${text.replace(/\s+/g, " ").slice(0, 100)}`,
        content: text,
        source: {
          kind: "conversation",
          sessionId: event.sessionId,
          externalId: event.id,
          capturedAt: event.occurredAt,
          retention: "full_text",
        },
      },
    });
  } catch (error) {
    // An inaccessible archived/rejected source or a concurrent creation must not
    // be overwritten. The stable entry ID makes retries converge without a new copy.
    if (nestedPostgresSqlState(error) === "40001")
      return {
        retained: false,
        entryId,
        reason:
          "This message already has a retained source or changed concurrently. Inspect available Knowledge before retrying; no source was overwritten or revived.",
      };
    throw error;
  }
  return { retained: true, ...receipt, messageId: event.id };
}
