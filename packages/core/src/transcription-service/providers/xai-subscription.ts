import { type Settings } from "@opengeni/config";
import type { RecordingTranscriptionProvider } from "../../recording-transcription";
import {
  requireScope,
  textModelCapabilities,
  textRequestAudio,
  textTranscriptionResult,
} from "../text-models";
import {
  getWorkspace,
  readSubscriptionCoreProviderRouteForWorkspace,
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
} from "@opengeni/xai-subscription";
import { workspaceXaiOperationAvailable } from "../../xai-operation-availability";
import { coreTranscriptionUnavailable, transcribeOnSubscriptionCore } from "./subscription-core";

const TRANSCRIBE_URL = `${XAI_PUBLIC_API_BASE_URL}/stt`;

/** The model the SuperGrok speech-to-text endpoint is offered as. */
export const XAI_TRANSCRIPTION_MODEL = "grok-stt";

export function createXaiSubscriptionTranscriptionProvider(input: {
  settings: Settings;
  db: Database;
  fetch?: typeof fetch;
}): RecordingTranscriptionProvider {
  const fetchImpl = input.fetch ?? fetch;
  return {
    id: "supergrok-subscription",
    name: "SuperGrok subscription",
    funding: "workspace_subscription",
    models: [
      {
        model: XAI_TRANSCRIPTION_MODEL,
        name: "Grok speech to text",
        capabilities: textModelCapabilities({
          maxDurationSeconds: 600,
          maxFileBytes: 25 * 1024 * 1024,
        }),
        // Paid for by the workspace's own subscription; Opengeni charges nothing.
        usdPerHour: 0,
      },
    ],
    async available(context?: { accountId?: string; workspaceId?: string; subjectId?: string }) {
      if (!context?.workspaceId || !context.subjectId) {
        return input.settings.supergrokSubscriptionEnabled;
      }
      const accountId =
        context.accountId ?? (await getWorkspace(input.db, context.workspaceId))?.accountId;
      // An unresolvable account fails closed rather than guessing a path.
      if (!accountId) return false;
      return await workspaceXaiOperationAvailable(input.db, input.settings, {
        accountId,
        workspaceId: context.workspaceId,
        subjectId: context.subjectId,
      });
    },
    async transcribe(request) {
      const { audio, mimeType, filename } = textRequestAudio(request);
      const { workspaceId, accountId, subjectId, requestId } = requireScope(request);
      const signal = request.signal;
      const send = async (fetcher: SubscriptionCoreFetch, accessToken: string) =>
        await sendXaiTranscription(fetcher, accessToken, {
          audio,
          mimeType,
          filename,
          requestId,
          signal,
        });
      const route = await readSubscriptionCoreProviderRouteForWorkspace(input.db, {
        accountId,
        workspaceId,
        provider: SUBSCRIPTION_CORE_XAI_PROVIDER,
      });
      // SuperGrok transcribes only on the shared core; any other route
      // (maintenance, or no receipt) is unavailable.
      if (route !== "core") throw coreTranscriptionUnavailable();
      // Decision 3: shared organization- or workspace-scoped connections
      // only; personal SuperGrok accounts never transcribe on the core.
      return textTranscriptionResult(
        await transcribeOnSubscriptionCore({
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
        }),
      );
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
