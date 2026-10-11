import { createHash } from "node:crypto";
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
  SubscriptionCoreCodexSourceDisconnectedError,
  reserveSubscriptionCoreCodexOperationRequest,
  settleSubscriptionCoreCodexOperationRequest,
  type Database,
  type SubscriptionCoreCodexOperationLeaseRef,
  type SubscriptionCoreCodexOperationScope,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import type { ObjectStorage } from "@opengeni/storage";
import type { GeneratedImageReceipt } from "./generated-images";
import { CodexCredentialLeaseLostError } from "./agent-turn/credential-leases";
import { findCodexCreditPolicyError } from "./agent-turn/codex-credit-policy";
import {
  executeImageGenerationOperation,
  imageGenerationOperationIdentity,
  imageProviderBindingHash,
  type ImageGenerationOperationPorts,
} from "./image-generation-operation";
import type { ResolvedImageGenerationReference } from "./image-generation-references";

/** Execute the same standalone subscription image path used by Codex clients. */
export async function executeCodexImageGeneration(
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
    codexContext: Pick<
      CodexRequestContext,
      | "clientVersion"
      | "getToken"
      | "refresh"
      | "beforeProviderDispatch"
      | "onProviderRequestSettled"
    >;
    abortSignal?: AbortSignal;
    /** Core turns only: the per-operation lease held around the provider call. */
    operationLease?: { acquire(): Promise<void>; release(): Promise<void> };
    /** Test seam for the provider request; production uses the Codex image client. */
    generateImage?: typeof generateCodexSubscriptionImage;
  },
  ports?: ImageGenerationOperationPorts,
): Promise<GeneratedImageReceipt> {
  const providerBindingHash = imageProviderBindingHash(CODEX_PROVIDER_ID, input.credentialId);
  let providerDispatchAdmitted = false;
  const codexContext: Pick<
    CodexRequestContext,
    "clientVersion" | "getToken" | "refresh" | "beforeProviderDispatch" | "onProviderRequestSettled"
  > = {
    ...input.codexContext,
    beforeProviderDispatch: async (request) => {
      await input.codexContext.beforeProviderDispatch?.(request);
      providerDispatchAdmitted = true;
    },
    onProviderRequestSettled: async (request) => {
      await input.codexContext.onProviderRequestSettled?.(request);
      if (request.outcome === "refused") providerDispatchAdmitted = false;
    },
  };
  return await executeImageGenerationOperation(
    {
      ...input,
      providerId: CODEX_PROVIDER_ID,
      providerBindingHash,
      modelId: CODEX_IMAGE_MODEL,
      ...(input.references ? { referenceDigests: input.references } : {}),
      isProviderDispatchRejected: (error) =>
        !providerDispatchAdmitted &&
        (error instanceof CodexCredentialLeaseLostError ||
          findCodexCreditPolicyError(error) !== null),
      generate: async () => {
        // A lease that cannot be taken is a verified pre-dispatch rejection:
        // the ledger returns to `prepared` and nothing reached the provider.
        await input.operationLease?.acquire();
        let generated: Awaited<ReturnType<typeof generateCodexSubscriptionImage>>;
        try {
          generated = await (input.generateImage ?? generateCodexSubscriptionImage)({
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
    },
    ...(ports ? [ports] : []),
  );
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
    /**
     * The turn's chat-lease dispatch fence (`leases.codex.assertCurrentForDispatch`):
     * an image operation runs only while its turn's live attempt still holds
     * the chat lease, checked before the operation lease is taken and before
     * the provider call.
     */
    assertChatLease: () => Promise<void>;
    /** Uses the same live account spending policy as the owning chat turn. */
    assertCreditAdmission: () => Promise<void>;
    deps?: {
      acquire?: typeof acquireSubscriptionCoreCodexOperationLease;
      renew?: typeof renewSubscriptionCoreCodexOperationLease;
      release?: typeof releaseSubscriptionCoreCodexOperationLease;
      resolver?: typeof buildSubscriptionCoreCodexConnectionTokenResolver;
      reserve?: typeof reserveSubscriptionCoreCodexOperationRequest;
      settle?: typeof settleSubscriptionCoreCodexOperationRequest;
      ports?: ImageGenerationOperationPorts;
      generateImage?: typeof generateCodexSubscriptionImage;
    };
  },
): Promise<GeneratedImageReceipt> {
  const acquire = input.deps?.acquire ?? acquireSubscriptionCoreCodexOperationLease;
  const renew = input.deps?.renew ?? renewSubscriptionCoreCodexOperationLease;
  const release = input.deps?.release ?? releaseSubscriptionCoreCodexOperationLease;
  const buildResolver = input.deps?.resolver ?? buildSubscriptionCoreCodexConnectionTokenResolver;
  const reserve = input.deps?.reserve ?? reserveSubscriptionCoreCodexOperationRequest;
  const settle = input.deps?.settle ?? settleSubscriptionCoreCodexOperationRequest;
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
    // Bounded (the column allows 256 characters): tool-call ids are provider-supplied.
    holderId: `image:${createHash("sha256").update(`${input.attemptId}\0${input.toolCallId}`).digest("hex")}`,
    generation: input.executionGeneration,
  };
  const resolver = buildResolver(input.db, input.settings, scope, input.core.connectionId, ref);
  // Nothing has reached the provider yet: any failure here, including a
  // transient database error, is a verified pre-dispatch rejection.
  const preDispatch = async (step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      if (error instanceof CodexCredentialLeaseLostError || findCodexCreditPolicyError(error))
        throw error;
      throw new CodexCredentialLeaseLostError("not_found");
    }
  };
  const unavailable = (error: unknown): never => {
    // The operation lost its lease, scope or enabled cutover before dispatch.
    if (
      error instanceof SubscriptionCoreCodexOperationUnavailableError ||
      error instanceof SubscriptionCoreCodexSourceDisconnectedError
    ) {
      throw new CodexCredentialLeaseLostError("not_found");
    }
    throw error;
  };
  const {
    deps: _deps,
    settings: _settings,
    core: _core,
    assertChatLease: _assertChatLease,
    assertCreditAdmission: _assertCreditAdmission,
    ...operationInput
  } = input;
  let pendingRequest: { operationId: string; responseReceived: boolean } | null = null;
  let uncertain = false;
  const receipt = await executeCodexImageGeneration(
    {
      ...operationInput,
      credentialId: input.core.connectionId,
      ...(input.deps?.generateImage ? { generateImage: input.deps.generateImage } : {}),
      codexContext: {
        clientVersion: input.clientVersion,
        getToken: () => resolver.getToken().catch(unavailable),
        refresh: () => resolver.refresh().catch(unavailable),
        beforeProviderDispatch: async (request) => {
          await preDispatch(async () => {
            if (!request || pendingRequest || uncertain)
              throw new Error("Image request predecessor is unsettled");
            await input.assertCreditAdmission();
            await input.assertChatLease();
            if (!(await renew(input.db, scope, ref))) {
              throw new CodexCredentialLeaseLostError("not_found");
            }
            const reserved = await reserve(input.db, scope, ref, input.core.connectionId, request);
            pendingRequest = { ...reserved, responseReceived: false };
          });
        },
        onProviderRequestSettled: async ({ outcome }) => {
          if (!pendingRequest) throw new Error("Image request settlement has no reservation");
          if (outcome === "response_received") {
            pendingRequest.responseReceived = true;
            return;
          }
          if (outcome === "unknown") uncertain = true;
          await settle(input.db, scope, { operationId: pendingRequest.operationId, outcome });
          pendingRequest = null;
        },
      },
      operationLease: {
        acquire: async () => {
          await preDispatch(async () => {
            await input.assertChatLease();
            const lease = await acquire(input.db, scope, ref);
            if (lease.kind !== "acquired") throw new CodexCredentialLeaseLostError("not_found");
          });
        },
        release: async () => {
          await release(input.db, scope, ref);
        },
      },
    },
    input.deps?.ports,
  );
  // The image operation has retained the bytes and committed its artifact
  // receipt. A transport success alone never licensed this native settlement.
  const completedRequest = pendingRequest as {
    operationId: string;
    responseReceived: boolean;
  } | null;
  if (completedRequest?.responseReceived) {
    await settle(input.db, scope, {
      operationId: completedRequest.operationId,
      outcome: "response_received",
    });
  }
  return receipt;
}
