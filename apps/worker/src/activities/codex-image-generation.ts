import {
  CODEX_PROVIDER_ID,
  generateCodexSubscriptionImage,
  type CodexRequestContext,
} from "@opengeni/codex";
import type { Database } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import type { GeneratedImageReceipt } from "./generated-images";
import { CodexCredentialLeaseLostError } from "./agent-turn/credential-leases";
import {
  executeImageGenerationOperation,
  imageProviderBindingHash,
} from "./image-generation-operation";
import type { ResolvedImageGenerationReference } from "./image-generation-references";

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
  references?: readonly ResolvedImageGenerationReference[];
  credentialId: string;
  codexContext: Pick<
    CodexRequestContext,
    "clientVersion" | "getToken" | "refresh" | "beforeProviderDispatch"
  >;
  abortSignal?: AbortSignal;
}): Promise<GeneratedImageReceipt> {
  const providerBindingHash = imageProviderBindingHash(CODEX_PROVIDER_ID, input.credentialId);
  let providerDispatchAdmitted = false;
  const codexContext: Pick<
    CodexRequestContext,
    "clientVersion" | "getToken" | "refresh" | "beforeProviderDispatch"
  > = {
    ...input.codexContext,
    beforeProviderDispatch: async () => {
      await input.codexContext.beforeProviderDispatch?.();
      providerDispatchAdmitted = true;
    },
  };
  return await executeImageGenerationOperation({
    ...input,
    providerId: CODEX_PROVIDER_ID,
    providerBindingHash,
    modelId: CODEX_IMAGE_MODEL,
    ...(input.references ? { referenceDigests: input.references } : {}),
    isProviderDispatchRejected: (error) =>
      !providerDispatchAdmitted && error instanceof CodexCredentialLeaseLostError,
    generate: async () => {
      const generated = await generateCodexSubscriptionImage({
        prompt: input.prompt,
        ...(input.references ? { references: input.references } : {}),
        turnId: input.turnId,
        context: codexContext,
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
