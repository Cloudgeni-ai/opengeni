import type { Settings } from "@opengeni/config";
import { TranscriptionServiceError } from "@opengeni/core";
import {
  subscriptionCoreOperationConnections,
  type Database,
  type SubscriptionCoreConnectionToken,
  type SubscriptionCoreFetch,
  type SubscriptionCoreProvider,
} from "@opengeni/db";
import { fetchError, responseError } from "./openai";

/**
 * Once a shared-core provider is selected, its failures are final for that
 * audio: provider ordering chose the initial provider only (design 6.5).
 */
export function coreTranscriptionUnavailable(): TranscriptionServiceError {
  return new TranscriptionServiceError({
    fallbackSafe: false,
    code: "unavailable",
    message: "Transcription is unavailable.",
  });
}

export function withoutFallback(error: TranscriptionServiceError): TranscriptionServiceError {
  return new TranscriptionServiceError({
    code: error.code,
    message: error.message,
    status: error.status,
    retryable: error.retryable,
    fallbackSafe: false,
  });
}

/** Parse a `{ text, language }` transcription body (response already buffered by custody). */
export async function coreTranscriptionResult(
  response: Response,
): Promise<{ text: string; languages: string[] }> {
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw withoutFallback(responseError(response.status));
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body.text !== "string") throw withoutFallback(responseError(502));
  return {
    text: body.text,
    languages: typeof body.language === "string" && body.language ? [body.language] : [],
  };
}

/**
 * Transcription on the shared subscription core for any provider (the M3
 * Codex rule, EP-N01..N04): a sessionless `transcription` operation for the
 * authenticated caller in an explicit account/workspace context, on a shared
 * organization- or workspace-scoped connection only, under its own operation
 * lease and the per-connection refresh lock. One forced refresh and one
 * retry when the provider refuses the bearer; nothing is retried through
 * another provider once a connection was selected.
 */
export async function transcribeOnSubscriptionCore(input: {
  db: Database;
  settings: Settings;
  provider: SubscriptionCoreProvider;
  fetch: SubscriptionCoreFetch;
  accountId: string;
  workspaceId: string;
  subjectId: string;
  requestId: string;
  send: (
    token: SubscriptionCoreConnectionToken,
    fetchImpl: SubscriptionCoreFetch,
  ) => Promise<Response>;
  /** The provider refused the bearer (refresh once and retry). */
  unauthorized: (response: Response) => Promise<boolean>;
}): Promise<{ text: string; languages: string[] }> {
  const scope = {
    kind: "workspace" as const,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
  };
  const connections = subscriptionCoreOperationConnections(input.provider);
  const candidates = await connections.listSubscriptionCoreOperationCandidates(input.db, scope);
  const ran = await connections.runSubscriptionCoreOperation(
    input.db,
    input.settings,
    scope,
    {
      candidates: candidates.map((candidate) => candidate.connectionId),
      operationKind: "transcription",
      holderId: `transcription:${input.requestId}`,
      requestId: `transcription:${input.requestId}`,
      fetchImpl: input.fetch,
    },
    async ({ resolver, fetch: requestFetch, fence }) => {
      const dispatch = async (force: boolean): Promise<Response> => {
        let token: SubscriptionCoreConnectionToken;
        try {
          token = force ? await resolver.refresh() : await resolver.getToken();
        } catch {
          throw coreTranscriptionUnavailable();
        }
        // Pre-dispatch fence: the exact operation lease must still be live.
        if (!(await fence())) throw coreTranscriptionUnavailable();
        return await input.send(token, requestFetch);
      };
      let response: Response;
      try {
        response = await dispatch(false);
        if (await input.unauthorized(response)) {
          await response.arrayBuffer().catch(() => undefined);
          response = await dispatch(true);
        }
      } catch (error) {
        if (error instanceof TranscriptionServiceError) throw error;
        // A provider transport failure keeps its classification but is never
        // replayed through another provider.
        throw withoutFallback(fetchError(error));
      }
      // Keep operation custody through parsing, not just response headers.
      return await coreTranscriptionResult(response);
    },
  );
  if (ran.kind === "unavailable") throw coreTranscriptionUnavailable();
  return ran.value;
}
