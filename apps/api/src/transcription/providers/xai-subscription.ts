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
      let response: Response;
      try {
        let token = await auth.context.getToken();
        response = await request(token.accessToken);
        if (response.status === 401) {
          await response.body?.cancel().catch(() => undefined);
          token = await auth.context.refresh();
          response = await request(token.accessToken);
        }
      } catch (error) {
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
