import { type Settings } from "@opengeni/config";
import {
  type TranscriptionAvailabilityContext,
  type TranscriptionProvider,
  TranscriptionServiceError,
} from "@opengeni/core";
import {
  getWorkspace,
  readSubscriptionCoreProviderRouteInScope,
  SUBSCRIPTION_CORE_XAI,
  SUBSCRIPTION_CORE_XAI_PROVIDER,
  subscriptionCoreXaiBearer,
  type Database,
  type SubscriptionCoreFetch,
} from "@opengeni/db";
import {
  XAI_CLIENT_MODE,
  XAI_CLIENT_VERSION,
  XAI_PUBLIC_API_BASE_URL,
  type XaiFetch,
} from "@opengeni/xai-subscription";
import { buildXaiSubscriptionAuthorization } from "../../xai-subscription-auth";
import { fetchError, responseError } from "./openai";
import { workspaceXaiOperationAvailable } from "../../xai-subscription-core";
import { coreTranscriptionUnavailable, transcribeOnSubscriptionCore } from "./subscription-core";

const TRANSCRIBE_URL = `${XAI_PUBLIC_API_BASE_URL}/stt`;

export function createXaiSubscriptionTranscriptionProvider(input: {
  settings: Settings;
  db: Database;
  fetch?: typeof fetch;
}): TranscriptionProvider {
  const fetchImpl = input.fetch ?? fetch;
  return {
    id: "supergrok-subscription",
    supportsServerDeadline: true,
    experimental: true,
    async available(context?: TranscriptionAvailabilityContext) {
      if (!context?.workspaceId || !context.subjectId) {
        return input.settings.supergrokSubscriptionEnabled;
      }
      const accountId = (await getWorkspace(input.db, context.workspaceId))?.accountId;
      // An unresolvable account fails closed rather than guessing a path.
      if (!accountId) return false;
      return await workspaceXaiOperationAvailable(input.db, input.settings, {
        accountId,
        workspaceId: context.workspaceId,
        subjectId: context.subjectId,
      });
    },
    async transcribe({
      audio,
      mimeType,
      filename,
      workspaceId,
      accountId,
      subjectId,
      requestId,
      signal,
    }) {
      const send = async (fetcher: SubscriptionCoreFetch, accessToken: string) =>
        await sendXaiTranscription(fetcher, accessToken, {
          audio,
          mimeType,
          filename,
          requestId,
          signal,
        });
      const route = await readSubscriptionCoreProviderRouteInScope(input.db, {
        accountId,
        workspaceId,
        provider: SUBSCRIPTION_CORE_XAI_PROVIDER,
      });
      if (route === "maintenance") throw coreTranscriptionUnavailable();
      if (route === "core") {
        // Decision 3: shared organization- or workspace-scoped connections
        // only; personal SuperGrok accounts never transcribe on the core.
        return await transcribeOnSubscriptionCore({
          db: input.db,
          settings: input.settings,
          provider: SUBSCRIPTION_CORE_XAI,
          fetch: fetchImpl,
          accountId,
          workspaceId,
          subjectId,
          requestId,
          send: async (token, requestFetch) =>
            await send(requestFetch, subscriptionCoreXaiBearer(token).accessToken),
          unauthorized: async (response) =>
            response.status === 401 || (await isXaiInvalidCredentialResponse(response)),
        });
      }
      let auth: Awaited<ReturnType<typeof buildXaiSubscriptionAuthorization>>;
      try {
        auth = await buildXaiSubscriptionAuthorization({
          db: input.db,
          settings: input.settings,
          accountId,
          workspaceId,
          subjectId,
          shardKey: requestId,
          sessionId: requestId,
          ...(input.fetch ? { fetch: input.fetch as XaiFetch } : {}),
        });
      } catch {
        throw new TranscriptionServiceError({
          code: "unavailable",
          fallbackSafe: true,
          message: "Transcription is unavailable.",
        });
      }
      const request = async (accessToken: string) => await send(fetchImpl, accessToken);
      const tokenForRequest = async (refresh: boolean) => {
        try {
          return await (refresh ? auth.context.refresh() : auth.context.getToken());
        } catch {
          throw new TranscriptionServiceError({
            code: "unavailable",
            message: "Reconnect the SuperGrok account to use transcription.",
            fallbackSafe: true,
          });
        }
      };
      let response: Response;
      try {
        let token = await tokenForRequest(false);
        response = await request(token.accessToken);
        if (response.status === 401 || (await isXaiInvalidCredentialResponse(response))) {
          await response.body?.cancel().catch(() => undefined);
          token = await tokenForRequest(true);
          response = await request(token.accessToken);
        }
      } catch (error) {
        if (error instanceof TranscriptionServiceError) throw error;
        throw fetchError(error);
      }
      if (!response.ok) throw responseError(response.status);
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body.text !== "string") throw responseError(502);
      return {
        text: body.text,
        languages: typeof body.language === "string" && body.language ? [body.language] : [],
      };
    },
  };
}

async function sendXaiTranscription(
  fetchImpl: SubscriptionCoreFetch,
  accessToken: string,
  input: {
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
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": `opengeni/${XAI_CLIENT_VERSION}`,
      "x-grok-client-version": XAI_CLIENT_VERSION,
      "x-grok-client-identifier": "opengeni",
      "x-grok-client-mode": XAI_CLIENT_MODE,
      "x-grok-session-id": input.requestId,
    },
    body: form,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function isXaiInvalidCredentialResponse(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16_384) return false;
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return (
      typeof body?.error === "string" &&
      body.error.includes("[WKE=unauthenticated:bad-credentials]")
    );
  } catch {
    return false;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
