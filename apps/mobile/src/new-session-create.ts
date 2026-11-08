import { isNewSessionDraftConflict } from "@opengeni/react/new-session-draft";
import type { CreateSessionRequest, CreateSessionResponse } from "@opengeni/sdk";

/**
 * Creates the chat for a new-chat Send, naming the draft it was composed in
 * so the server can clear that draft. A server from before Send wins refuses
 * a create that does not match the saved draft exactly, and mobile's never
 * matches when it trims the message or captions a file-only one. Such a
 * refusal comes before anything is created, so it is retried once without
 * the draft, as those servers always accepted; the emptied box's autosave
 * then clears the draft.
 */
export async function createSessionFromDraft(
  client: {
    createSession(
      workspaceId: string,
      request: CreateSessionRequest,
    ): Promise<CreateSessionResponse>;
  },
  workspaceId: string,
  request: CreateSessionRequest,
  draftRevision: number | null,
): Promise<CreateSessionResponse> {
  if (draftRevision === null) return await client.createSession(workspaceId, request);
  try {
    return await client.createSession(workspaceId, {
      ...request,
      expectedNewSessionDraftRevision: draftRevision,
    });
  } catch (cause) {
    if (!isNewSessionDraftConflict(cause)) throw cause;
    return await client.createSession(workspaceId, request);
  }
}
