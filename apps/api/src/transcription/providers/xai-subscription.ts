import { type Settings } from "@opengeni/config";
import {
  type TranscriptionAvailabilityContext,
  type TranscriptionProvider,
  TranscriptionServiceError,
} from "@opengeni/core";
import { workspaceXaiSubscriptionActive, type Database } from "@opengeni/db";
import {
  XAI_CLIENT_MODE,
  XAI_CLIENT_VERSION,
  XAI_PUBLIC_API_BASE_URL,
  type XaiFetch,
} from "@opengeni/xai-subscription";
import { buildXaiSubscriptionAuthorization } from "../../xai-subscription-auth";
import { fetchError, responseError } from "./openai";

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
      return await workspaceXaiSubscriptionActive(
        input.db,
        input.settings,
        context.workspaceId,
        context.subjectId,
      );
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
      const request = async (accessToken: string) => {
        const form = new FormData();
        form.append(
          "file",
          new Blob([Uint8Array.from(audio).buffer], { type: mimeType }),
          filename,
        );
        return await fetchImpl(TRANSCRIBE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": `opengeni/${XAI_CLIENT_VERSION}`,
            "x-grok-client-version": XAI_CLIENT_VERSION,
            "x-grok-client-identifier": "opengeni",
            "x-grok-client-mode": XAI_CLIENT_MODE,
            "x-grok-session-id": requestId,
          },
          body: form,
          ...(signal ? { signal } : {}),
        });
      };
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
