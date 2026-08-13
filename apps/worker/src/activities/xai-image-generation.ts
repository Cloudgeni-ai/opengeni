import {
  generateXaiSubscriptionImage,
  XAI_IMAGE_MODEL,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  type XaiSubscriptionRequestContext,
} from "@opengeni/xai-subscription";
import type { Database } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import type { GeneratedImageReceipt } from "./generated-images";
import {
  executeImageGenerationOperation,
  imageProviderBindingHash,
} from "./image-generation-operation";
import type { ResolvedImageGenerationReference } from "./image-generation-references";

export type XaiImageGenerationPorts = {
  execute: typeof executeImageGenerationOperation;
  generate: typeof generateXaiSubscriptionImage;
};

const xaiImageGenerationPorts: XaiImageGenerationPorts = {
  execute: executeImageGenerationOperation,
  generate: generateXaiSubscriptionImage,
};

/** Execute xAI's standalone subscription image path under the durable paid-operation fence. */
export async function executeXaiSubscriptionImageGeneration(
  input: {
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
    xaiContext: Pick<XaiSubscriptionRequestContext, "getToken" | "refresh">;
    abortSignal?: AbortSignal;
  },
  ports: XaiImageGenerationPorts = xaiImageGenerationPorts,
): Promise<GeneratedImageReceipt> {
  if (input.references?.length) {
    throw new Error("SuperGrok image generation does not support reference images");
  }
  const providerBindingHash = imageProviderBindingHash(
    XAI_SUBSCRIPTION_PROVIDER_ID,
    input.credentialId,
  );
  return await ports.execute({
    db: input.db,
    objectStorage: input.objectStorage,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    toolCallId: input.toolCallId,
    prompt: input.prompt,
    providerId: XAI_SUBSCRIPTION_PROVIDER_ID,
    providerBindingHash,
    modelId: XAI_IMAGE_MODEL,
    generate: async () => {
      const generated = await ports.generate({
        prompt: input.prompt,
        getToken: input.xaiContext.getToken,
        refresh: input.xaiContext.refresh,
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
