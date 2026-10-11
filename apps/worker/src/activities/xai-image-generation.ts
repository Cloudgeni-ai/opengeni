import {
  generateXaiSubscriptionImage,
  XAI_IMAGE_MODEL,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  type XaiSubscriptionRequestContext,
} from "@opengeni/xai-subscription";
import type { Settings } from "@opengeni/config";
import {
  SUBSCRIPTION_CORE_XAI,
  subscriptionCoreXaiFetch,
  subscriptionCoreXaiRequestAuth,
  type Database,
  type SubscriptionCoreFetch,
  type SubscriptionCoreProvider,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import type { GeneratedImageReceipt } from "./generated-images";
import {
  executeImageGenerationOperation,
  imageGenerationOperationIdentity,
  imageProviderBindingHash,
} from "./image-generation-operation";
import type { ResolvedImageGenerationReference } from "./image-generation-references";
import {
  runSubscriptionCoreImageOperation,
  SubscriptionCoreImageDispatchRejected,
} from "./subscription-core-image-operation";

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
        sessionId: input.sessionId,
        ...(input.references?.length
          ? {
              references: input.references.map((reference) => ({
                mediaType: reference.mediaType,
                bytes: reference.bytes,
              })),
            }
          : {}),
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

/**
 * SuperGrok image generation of a turn placed on the shared core (design
 * 5.3, EP-N09/N10): the turn's placed connection under its own `image`
 * operation lease, the bearer from the core seam and every request in the
 * core's custody. A refused lease or fence before dispatch returns the
 * ledger row to `prepared`.
 */
export async function executeCoreXaiImageGeneration(
  input: Omit<
    Parameters<typeof executeXaiSubscriptionImageGeneration>[0],
    "credentialId" | "xaiContext"
  > & {
    settings: Settings;
    core: { identity: SubscriptionCoreTurnIdentity; connectionId: string };
    executionGeneration: number;
    /** The turn's chat-lease dispatch fence (`leases.xai.assertCurrentForDispatch`). */
    assertChatLease: () => Promise<void>;
    provider?: SubscriptionCoreProvider;
    fetchImpl?: SubscriptionCoreFetch;
  },
  ports: XaiImageGenerationPorts = xaiImageGenerationPorts,
): Promise<GeneratedImageReceipt> {
  const providerBindingHash = imageProviderBindingHash(
    XAI_SUBSCRIPTION_PROVIDER_ID,
    input.core.connectionId,
  );
  const request = {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    providerId: XAI_SUBSCRIPTION_PROVIDER_ID,
    providerBindingHash,
    modelId: XAI_IMAGE_MODEL,
    prompt: input.prompt,
    ...(input.references ? { referenceDigests: input.references } : {}),
  };
  return await ports.execute({
    ...request,
    db: input.db,
    objectStorage: input.objectStorage,
    accountId: input.accountId,
    attemptId: input.attemptId,
    isProviderDispatchRejected: (error) => error instanceof SubscriptionCoreImageDispatchRejected,
    generate: async () =>
      await runSubscriptionCoreImageOperation(
        {
          db: input.db,
          settings: input.settings,
          provider: input.provider ?? (SUBSCRIPTION_CORE_XAI as SubscriptionCoreProvider),
          identity: input.core.identity,
          connectionId: input.core.connectionId,
          attemptId: input.attemptId,
          executionGeneration: input.executionGeneration,
          operationId: imageGenerationOperationIdentity(request).operationId,
          toolCallId: input.toolCallId,
          assertChatLease: input.assertChatLease,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        },
        async ({ resolver, fetch }) => {
          const auth = subscriptionCoreXaiRequestAuth(resolver);
          const generated = await ports.generate({
            prompt: input.prompt,
            sessionId: input.sessionId,
            ...(input.references?.length
              ? {
                  references: input.references.map((reference) => ({
                    mediaType: reference.mediaType,
                    bytes: reference.bytes,
                  })),
                }
              : {}),
            getToken: auth.getToken,
            refresh: auth.refresh,
            fetch: subscriptionCoreXaiFetch(fetch),
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
          return {
            toolCallId: input.toolCallId,
            providerItemId: null,
            bytes: generated.bytes,
            declaredMediaType: generated.declaredMediaType,
          };
        },
      ),
  });
}
