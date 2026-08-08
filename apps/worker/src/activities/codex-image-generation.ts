import {
  CODEX_PROVIDER_ID,
  generateCodexSubscriptionImage,
  type CodexRequestContext,
} from "@opengeni/codex";
import type { Database } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import type { GeneratedImageReceipt } from "./generated-images";
import {
  executeImageGenerationOperation,
  imageProviderBindingHash,
} from "./image-generation-operation";

const CODEX_IMAGE_MODEL = "gpt-image-2";

/** Execute the same standalone subscription image path used by Codex clients. */
export async function executeCodexImageGeneration(input: {
  db: Database;
  objectStorage: ObjectStorage | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  toolCallId: string;
  prompt: string;
  credentialId: string;
  codexContext: Pick<CodexRequestContext, "clientVersion" | "getToken" | "refresh">;
  abortSignal?: AbortSignal;
}): Promise<GeneratedImageReceipt> {
  const providerBindingHash = imageProviderBindingHash(CODEX_PROVIDER_ID, input.credentialId);
  return await executeImageGenerationOperation({
    ...input,
    providerId: CODEX_PROVIDER_ID,
    providerBindingHash,
    modelId: CODEX_IMAGE_MODEL,
    generate: async () => {
      const generated = await generateCodexSubscriptionImage({
        prompt: input.prompt,
        turnId: input.turnId,
        context: input.codexContext,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      return {
        toolCallId: input.toolCallId,
        providerItemId: null,
        bytes: generated.bytes,
        declaredMediaType: generated.declaredMediaType,
      };
    },
  });
}
