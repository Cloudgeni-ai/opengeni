import {
  assistantMessagePhase,
  type AccessGrant,
  type ContinueSessionRequest,
  type CreateSessionResponse,
  type SessionEvent,
} from "@opengeni/contracts";
import {
  buildSessionContinuationContext,
  createSessionForRequest,
  defaultSessionContinuationMessage,
  SESSION_CONTINUED_FROM_METADATA_KEY,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
  type SessionContinuationMessage,
} from "@opengeni/core";
import { getSessionForSubject, listSessionEventPage } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

/** Messages read from the end of the earlier chat; the context keeps what fits. */
const RECENT_MESSAGE_LIMIT = 400;
/** Progress notes matter less than answers and requests. */
const COMMENTARY_MAX_CHARS = 1_000;

function conversationMessage(event: SessionEvent): SessionContinuationMessage | null {
  if (event.duplicateOfEventId || (event.turnAssociation && event.turnAssociation !== "current"))
    return null;
  const payload = event.payload as Record<string, unknown> | null;
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text) return null;
  if (event.type === "user.message") return { role: "user", text };
  if (event.type !== "agent.message.completed") return null;
  return {
    role: "assistant",
    text:
      assistantMessagePhase(payload) === "commentary" ? text.slice(0, COMMENTARY_MAX_CHARS) : text,
  };
}

/**
 * Read the earlier chat's requests and answers, oldest first: the first
 * request plus the most recent messages. The caller has already authorized
 * reading the chat.
 */
async function readContinuationMessages(
  db: ApiRouteDeps["db"],
  workspaceId: string,
  sessionId: string,
): Promise<SessionContinuationMessage[]> {
  const [recent, opening] = await Promise.all([
    listSessionEventPage(db, workspaceId, sessionId, {
      includeTypes: ["user.message", "agent.message.completed"],
      direction: "before",
      limit: RECENT_MESSAGE_LIMIT,
      payloadMode: "full",
    }),
    listSessionEventPage(db, workspaceId, sessionId, {
      includeTypes: ["user.message"],
      direction: "after",
      limit: 1,
      payloadMode: "full",
    }),
  ]);
  const events = [...recent.events].sort((a, b) => a.sequence - b.sequence);
  const first = opening.events[0];
  if (first && !events.some((event) => event.sequence === first.sequence)) events.unshift(first);
  return events.flatMap((event) => {
    const message = conversationMessage(event);
    return message ? [message] : [];
  });
}

/**
 * Start a new chat on `request.model` that continues `sourceSessionId`. The
 * earlier chat is only read, never changed, so a chat frozen on Codex remote
 * compaction keeps its lock. The new chat is an ordinary create: the same
 * admission, model policy, billing and idempotency rules apply. It keeps the
 * earlier chat's resources, visibility and machine, and links back to it.
 */
export async function continueSessionInNewChat(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  sourceSessionId: string,
  request: ContinueSessionRequest,
  authorization?: AccessGrantAuthorization,
): Promise<CreateSessionResponse> {
  const source = await getSessionForSubject(deps.db, workspaceId, sourceSessionId, grant.subjectId);
  if (!source) throw new HTTPException(404, { message: "session not found" });
  const messages = await readContinuationMessages(deps.db, workspaceId, source.id);
  const modelContext = buildSessionContinuationContext({
    sourceSessionId: source.id,
    sourceTitle: source.title,
    sourceModel: source.model,
    messages,
  });
  const payload = {
    idempotencyKey: request.idempotencyKey,
    ...(request.clientEventId ? { clientEventId: request.clientEventId } : {}),
    initialMessage:
      request.initialMessage ??
      defaultSessionContinuationMessage({ sourceSessionId: source.id, sourceTitle: source.title }),
    modelContext,
    ...(request.timeZone ? { timeZone: request.timeZone } : {}),
    model: request.model,
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    ...(request.latencyMode ? { latencyMode: request.latencyMode } : {}),
    resources: source.resources,
    ...(source.tenancy ? { visibility: source.tenancy.visibility } : {}),
    // A Connected Machine is shared; a managed sandbox belongs to its own chat.
    ...(source.sandboxBackend === "selfhosted" && source.activeSandboxId
      ? {
          targetSandboxId: source.activeSandboxId,
          ...(source.workingDir ? { workingDir: source.workingDir } : {}),
        }
      : {}),
    metadata: { [SESSION_CONTINUED_FROM_METADATA_KEY]: source.id },
  };
  return await createSessionForRequest(deps, grant, workspaceId, payload, authorization);
}
