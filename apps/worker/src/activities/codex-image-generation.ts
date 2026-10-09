import {
  CODEX_PROVIDER_ID,
  CODEX_IMAGE_MODEL,
  generateCodexSubscriptionImage,
  type CodexRequestContext,
} from "@opengeni/codex";
import {
  acquireSubscriptionCoreCodexOperationLease,
  buildSubscriptionCoreCodexConnectionTokenResolver,
  releaseSubscriptionCoreCodexOperationLease,
  renewSubscriptionCoreCodexOperationLease,
  SubscriptionCoreCodexOperationUnavailableError,
  type Database,
  type SubscriptionCoreCodexOperationLeaseRef,
  type SubscriptionCoreCodexOperationScope,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import type { ObjectStorage } from "@opengeni/storage";
import type { GeneratedImageReceipt } from "./generated-images";
import { CodexCredentialLeaseLostError } from "./agent-turn/credential-leases";
import {
  executeImageGenerationOperation,
  imageGenerationOperationIdentity,
  imageProviderBindingHash,
} from "./image-generation-operation";
import type { ResolvedImageGenerationReference } from "./image-generation-references";

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
  /** Core turns only: the per-operation lease held around the provider call. */
  operationLease?: { acquire(): Promise<void>; release(): Promise<void> };
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
      // A lease that cannot be taken is a verified pre-dispatch rejection:
      // the ledger returns to `prepared` and nothing reached the provider.
      await input.operationLease?.acquire();
      let generated: Awaited<ReturnType<typeof generateCodexSubscriptionImage>>;
      try {
        generated = await generateCodexSubscriptionImage({
          prompt: input.prompt,
          ...(input.references ? { references: input.references } : {}),
          turnId: input.turnId,
          context: codexContext,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        });
      } finally {
        await input.operationLease?.release().catch(() => undefined);
      }
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
 * A Codex image operation of a turn placed by the shared subscription core
 * (M3 PR 2c, EP-T17). It runs on the turn's own leased chat connection under
 * the turn's accepted authority, but holds its own operation lease (kind
 * `image`, keyed by the ledger's turn/tool-call operation id) and reads and
 * refreshes the credential through the operation seam. The chat-turn lease
 * and the session binding are never read or written, so concurrent image
 * calls never contend with the chat turn or each other.
 */
export async function executeCoreCodexImageGeneration(
  input: Omit<
    Parameters<typeof executeCodexImageGeneration>[0],
    "credentialId" | "codexContext" | "operationLease"
  > & {
    settings: Settings;
    core: { identity: SubscriptionCoreTurnIdentity; connectionId: string };
    executionGeneration: number;
    clientVersion: string;
    deps?: {
      acquire?: typeof acquireSubscriptionCoreCodexOperationLease;
      renew?: typeof renewSubscriptionCoreCodexOperationLease;
      release?: typeof releaseSubscriptionCoreCodexOperationLease;
      resolver?: typeof buildSubscriptionCoreCodexConnectionTokenResolver;
    };
  },
): Promise<GeneratedImageReceipt> {
  const acquire = input.deps?.acquire ?? acquireSubscriptionCoreCodexOperationLease;
  const renew = input.deps?.renew ?? renewSubscriptionCoreCodexOperationLease;
  const release = input.deps?.release ?? releaseSubscriptionCoreCodexOperationLease;
  const buildResolver = input.deps?.resolver ?? buildSubscriptionCoreCodexConnectionTokenResolver;
  const scope: SubscriptionCoreCodexOperationScope = {
    kind: "turn",
    identity: input.core.identity,
  };
  const { operationId } = imageGenerationOperationIdentity({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    providerId: CODEX_PROVIDER_ID,
    providerBindingHash: imageProviderBindingHash(CODEX_PROVIDER_ID, input.core.connectionId),
    modelId: CODEX_IMAGE_MODEL,
    prompt: input.prompt,
    ...(input.references ? { referenceDigests: input.references } : {}),
  });
  const ref: SubscriptionCoreCodexOperationLeaseRef = {
    operationId,
    attemptId: input.attemptId,
    operationKind: "image",
    connectionId: input.core.connectionId,
    holderId: `image:${input.attemptId}:${input.toolCallId}`,
    generation: input.executionGeneration,
  };
  const resolver = buildResolver(input.db, input.settings, scope, input.core.connectionId, ref);
  const unavailable = (error: unknown): never => {
    // The operation lost its lease, scope or enabled cutover before dispatch.
    if (error instanceof SubscriptionCoreCodexOperationUnavailableError) {
      throw new CodexCredentialLeaseLostError("not_found");
    }
    throw error;
  };
  return await executeCodexImageGeneration({
    ...input,
    credentialId: input.core.connectionId,
    codexContext: {
      clientVersion: input.clientVersion,
      getToken: () => resolver.getToken().catch(unavailable),
      refresh: () => resolver.refresh().catch(unavailable),
      beforeProviderDispatch: async () => {
        if (!(await renew(input.db, scope, ref)))
          throw new CodexCredentialLeaseLostError("not_found");
      },
    },
    operationLease: {
      acquire: async () => {
        const lease = await acquire(input.db, scope, ref);
        if (lease.kind !== "acquired") throw new CodexCredentialLeaseLostError("not_found");
      },
      release: async () => {
        await release(input.db, scope, ref);
      },
    },
  });
}
