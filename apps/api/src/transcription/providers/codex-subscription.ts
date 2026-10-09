import { CODEX_CLIENT_VERSION, CODEX_ORIGINATOR } from "@opengeni/codex/constants";
import type { Settings } from "@opengeni/config";
import {
  type TranscriptionAvailabilityContext,
  type TranscriptionProvider,
  TranscriptionServiceError,
} from "@opengeni/core";
import {
  acquireSubscriptionCoreCodexOperationLease,
  buildSubscriptionCoreCodexConnectionTokenResolver,
  getWorkspace,
  listSubscriptionCoreCodexOperationCandidates,
  readCodexCutoverDisposition,
  releaseSubscriptionCoreCodexOperationLease,
  renewSubscriptionCoreCodexOperationLease,
  type Database,
  type SubscriptionCoreCodexOperationLeaseRef,
  type SubscriptionCoreCodexOperationScope,
} from "@opengeni/db";
import { fetchError, responseError } from "./openai";

const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";

/**
 * Once the shared-core Codex provider is selected, its failures are final for
 * that audio: provider ordering chose the initial provider only (design 6.5).
 */
function coreTranscriptionUnavailable(): TranscriptionServiceError {
  return new TranscriptionServiceError({
    fallbackSafe: false,
    code: "unavailable",
    message: "Transcription is unavailable.",
  });
}

/**
 * Codex transcription on the shared subscription core (M3 PR 2c, EP-N01..N04):
 * a sessionless operation for the authenticated caller in an explicit
 * account/workspace context, on a shared organization- or workspace-scoped
 * connection only, under its own operation lease and the per-connection
 * refresh lock. It never reads the legacy active pointer.
 */
async function transcribeOnCore(
  input: { settings: Settings; db: Database; fetch: typeof fetch },
  request: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    requestId: string;
    send: (accessToken: string, accountId: string | null) => Promise<Response>;
  },
): Promise<Response> {
  const scope: SubscriptionCoreCodexOperationScope = {
    kind: "workspace",
    accountId: request.accountId,
    workspaceId: request.workspaceId,
    subjectId: request.subjectId,
  };
  const candidates = await listSubscriptionCoreCodexOperationCandidates(input.db, scope);
  const operationId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  for (const candidate of candidates) {
    const ref: SubscriptionCoreCodexOperationLeaseRef = {
      operationId,
      attemptId,
      operationKind: "transcription",
      connectionId: candidate.connectionId,
      holderId: `transcription:${request.requestId}`.slice(0, 256),
      generation: 1,
    };
    const lease = await acquireSubscriptionCoreCodexOperationLease(input.db, scope, ref);
    if (lease.kind !== "acquired") continue;
    try {
      const resolver = buildSubscriptionCoreCodexConnectionTokenResolver(
        input.db,
        input.settings,
        scope,
        candidate.connectionId,
        ref,
      );
      const dispatch = async (force: boolean): Promise<Response> => {
        const token = force ? await resolver.refresh() : await resolver.getToken();
        // Pre-dispatch fence: the exact operation lease must still be live.
        if (!(await renewSubscriptionCoreCodexOperationLease(input.db, scope, ref))) {
          throw coreTranscriptionUnavailable();
        }
        return await request.send(token.accessToken, token.chatgptAccountId);
      };
      let response: Response;
      try {
        response = await dispatch(false);
        if (response.status === 401) response = await dispatch(true);
      } catch (error) {
        if (error instanceof TranscriptionServiceError) throw error;
        // A provider transport failure keeps its classification but is never
        // replayed through another provider.
        throw withoutFallback(fetchError(error));
      }
      return response;
    } finally {
      await releaseSubscriptionCoreCodexOperationLease(input.db, scope, ref).catch(() => false);
    }
  }
  throw coreTranscriptionUnavailable();
}

function withoutFallback(error: TranscriptionServiceError): TranscriptionServiceError {
  return new TranscriptionServiceError({
    code: error.code,
    message: error.message,
    status: error.status,
    retryable: error.retryable,
    fallbackSafe: false,
  });
}

async function sendTranscription(
  fetchImpl: typeof fetch,
  input: {
    accessToken: string;
    chatgptAccountId: string | null;
    audio: Uint8Array;
    mimeType: string;
    filename: string;
    requestId: string;
    signal?: AbortSignal | undefined;
  },
): Promise<Response> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([Uint8Array.from(input.audio).buffer], { type: input.mimeType }),
    input.filename,
  );
  return await fetchImpl(TRANSCRIBE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      ...(input.chatgptAccountId ? { "ChatGPT-Account-ID": input.chatgptAccountId } : {}),
      originator: CODEX_ORIGINATOR,
      "User-Agent": `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`,
      version: CODEX_CLIENT_VERSION,
      "x-opengeni-request-id": input.requestId,
    },
    body: form,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

async function transcriptionResult(
  response: Response,
): Promise<{ text: string; languages: string[] }> {
  if (!response.ok) throw withoutFallback(responseError(response.status));
  const body = await response.json().catch(() => null);
  if (!body || typeof body.text !== "string") throw withoutFallback(responseError(502));
  return {
    text: body.text,
    languages: typeof body.language === "string" && body.language ? [body.language] : [],
  };
}

export function createCodexSubscriptionTranscriptionProvider(input: {
  settings: Settings;
  db: Database;
  fetch?: typeof fetch;
  probe?: (context?: TranscriptionAvailabilityContext) => boolean | Promise<boolean>;
}): TranscriptionProvider {
  const fetchImpl = input.fetch ?? fetch;
  const probe =
    input.probe ??
    (async (context?: TranscriptionAvailabilityContext) => {
      // Deployment-level readiness: registry construction already gated this
      // provider on OPENGENI_CODEX_SUBSCRIPTION_ENABLED. Request selection
      // passes workspaceId so we only claim Codex when a subscription is
      // attached; otherwise OpenAI/Azure remain eligible.
      if (!context?.workspaceId) return true;
      const accountId =
        (context as { accountId?: string }).accountId ??
        (await getWorkspace(input.db, context.workspaceId))?.accountId;
      // An unresolvable account fails closed rather than guessing a path.
      if (!accountId) return false;
      const disposition = await readCodexCutoverDisposition(
        input.db,
        accountId,
        context.workspaceId,
      );
      // A disabled cutover row is maintenance: unavailable, no legacy read.
      if (disposition === "maintenance") return false;
      if (disposition === "core") {
        const candidates = await listSubscriptionCoreCodexOperationCandidates(input.db, {
          kind: "workspace",
          accountId,
          workspaceId: context.workspaceId,
          subjectId: context.subjectId ?? "service:subscription-core",
        });
        return candidates.length > 0;
      }
      return false;
    });
  return {
    id: "codex-subscription",
    supportsServerDeadline: true,
    experimental: true,
    available: probe,
    async transcribe({
      audio,
      mimeType,
      filename,
      workspaceId,
      accountId: organizationId,
      subjectId,
      requestId,
      signal,
    }) {
      const disposition = await readCodexCutoverDisposition(input.db, organizationId, workspaceId);
      if (disposition === "maintenance") throw coreTranscriptionUnavailable();

      const response = await transcribeOnCore(
        { settings: input.settings, db: input.db, fetch: fetchImpl },
        {
          accountId: organizationId,
          workspaceId,
          subjectId,
          requestId,
          send: async (accessToken, chatgptAccountId) =>
            await sendTranscription(fetchImpl, {
              accessToken,
              chatgptAccountId,
              audio,
              mimeType,
              filename,
              requestId,
              signal,
            }),
        },
      );
      return await transcriptionResult(response);
    },
  };
}
