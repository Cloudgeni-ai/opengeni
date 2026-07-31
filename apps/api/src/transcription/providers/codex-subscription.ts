import { CODEX_CLIENT_VERSION, CODEX_ORIGINATOR } from "@opengeni/codex/constants";
import type { Settings } from "@opengeni/config";
import {
  type TranscriptionAvailabilityContext,
  type TranscriptionProvider,
  TranscriptionServiceError,
} from "@opengeni/core";
import { buildCodexTokenResolver, type Database, listCodexAccountStatuses } from "@opengeni/db";
import { fetchError, responseError } from "./openai";

const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";

async function workspaceHasActiveCodexAccount(db: Database, workspaceId: string): Promise<boolean> {
  const account = (await listCodexAccountStatuses(db, workspaceId)).find(
    (candidate) => candidate.isActive && candidate.status === "active",
  );
  return account != null;
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
      return await workspaceHasActiveCodexAccount(input.db, context.workspaceId);
    });
  return {
    id: "codex-subscription",
    experimental: true,
    available: probe,
    async transcribe({ audio, mimeType, filename, workspaceId, signal }) {
      const account = (await listCodexAccountStatuses(input.db, workspaceId)).find(
        (candidate) => candidate.isActive && candidate.status === "active",
      );
      if (!account) {
        throw new TranscriptionServiceError({
          code: "unavailable",
          message: "Transcription is unavailable.",
        });
      }
      const resolver = buildCodexTokenResolver(input.db, input.settings, workspaceId, account.id);
      let token: Awaited<ReturnType<typeof resolver.getToken>>;
      try {
        token = await resolver.getToken();
      } catch {
        throw new TranscriptionServiceError({
          code: "unavailable",
          message: "Transcription is unavailable.",
        });
      }
      const request = async (accessToken: string, accountId: string | null) => {
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
            ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
            originator: CODEX_ORIGINATOR,
            "User-Agent": `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`,
            version: CODEX_CLIENT_VERSION,
          },
          body: form,
          ...(signal ? { signal } : {}),
        });
      };
      let response: Response;
      try {
        response = await request(token.accessToken, token.chatgptAccountId);
        if (response.status === 401) {
          token = await resolver.refresh();
          response = await request(token.accessToken, token.chatgptAccountId);
        }
      } catch (error) {
        throw fetchError(error);
      }
      if (!response.ok) throw responseError(response.status);
      const body = await response.json().catch(() => null);
      if (!body || typeof body.text !== "string") throw responseError(502);
      return {
        text: body.text,
        languages: typeof body.language === "string" && body.language ? [body.language] : [],
      };
    },
  };
}
