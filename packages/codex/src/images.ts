import { CODEX_CLIENT_VERSION, CODEX_ORIGINATOR, CODEX_RESPONSES_BASE } from "./constants";
import type { CodexRequestContext, CodexTokenSnapshot } from "./request-context";
import type { FetchLike } from "./fetch";
import { readJsonBase64Field, readResponseTextBounded } from "@opengeni/network";

const CODEX_IMAGE_MODEL = "gpt-image-2";
const CODEX_IMAGE_RESPONSE_MAX_BYTES = 90 * 1024 * 1024;
const CODEX_IMAGE_ERROR_MAX_BYTES = 64 * 1024;
const CODEX_IMAGE_MAX_BYTES = 64 * 1024 * 1024;

export type CodexGeneratedImage = {
  bytes: Uint8Array;
  declaredMediaType: "image/png";
};

export class CodexImageApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CodexImageApiError";
  }
}

/**
 * Execute Codex's standalone, client-side image tool against the same
 * ChatGPT/Codex account as the owning model turn. Only a definitive 401 is
 * retried, after refreshing auth; ambiguous transport/5xx outcomes are never
 * replayed because an image request may already have incurred work or cost.
 */
export async function generateCodexSubscriptionImage(input: {
  prompt: string;
  turnId: string;
  context: Pick<CodexRequestContext, "clientVersion" | "getToken" | "refresh">;
  abortSignal?: AbortSignal;
  fetch?: FetchLike;
}): Promise<CodexGeneratedImage> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const request = async (auth: CodexTokenSnapshot): Promise<Response> => {
    const headers = codexImageHeaders(auth, input.context.clientVersion, input.turnId);
    return await fetchImpl(`${CODEX_RESPONSES_BASE}/images/generations`, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({
        prompt: input.prompt,
        background: "auto",
        model: CODEX_IMAGE_MODEL,
        quality: "auto",
        size: "auto",
      }),
      ...(input.abortSignal ? { signal: input.abortSignal } : {}),
    });
  };

  let response = await request(await input.context.getToken());
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    response = await request(await input.context.refresh());
  }
  if (!response.ok) {
    const detail = await readResponseTextBounded(
      response,
      CODEX_IMAGE_ERROR_MAX_BYTES,
      "Codex image error",
      input.abortSignal ? { signal: input.abortSignal } : {},
    ).catch(() => "");
    throw new CodexImageApiError(
      response.status,
      detail
        ? `Codex image generation failed (${response.status}): ${boundedErrorMessage(detail)}`
        : `Codex image generation failed (${response.status})`,
    );
  }

  const bytes = await readJsonBase64Field(response, {
    fieldName: "b64_json",
    shape: "string",
    maxResponseBytes: CODEX_IMAGE_RESPONSE_MAX_BYTES,
    maxDecodedBytes: CODEX_IMAGE_MAX_BYTES,
    label: "Codex image generation",
    ...(input.abortSignal ? { signal: input.abortSignal } : {}),
  });
  return { bytes, declaredMediaType: "image/png" };
}

function codexImageHeaders(
  auth: CodexTokenSnapshot,
  clientVersion: string,
  turnId: string,
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${auth.accessToken}`,
    accept: "application/json",
    "content-type": "application/json",
    originator: CODEX_ORIGINATOR,
    "User-Agent": `${CODEX_ORIGINATOR}/${clientVersion || CODEX_CLIENT_VERSION}`,
    version: clientVersion || CODEX_CLIENT_VERSION,
    "x-codex-image-turn-id": turnId,
  });
  if (auth.chatgptAccountId) headers.set("ChatGPT-Account-ID", auth.chatgptAccountId);
  if (auth.isFedramp) headers.set("X-OpenAI-Fedramp", "true");
  return headers;
}

function boundedErrorMessage(body: string): string {
  let message = body;
  try {
    const value = JSON.parse(body) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const candidate = value.error?.message ?? value.message;
    if (typeof candidate === "string") message = candidate;
  } catch {
    // Preserve a bounded non-JSON provider diagnostic.
  }
  return message.replace(/\s+/g, " ").trim().slice(0, 1_000);
}
