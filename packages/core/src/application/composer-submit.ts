import type {
  AccessGrant,
  ResourceRef,
  SubmitComposerDraftRequest,
  SubmitComposerDraftResponse,
} from "@opengeni/contracts";
import type { AccessGrantAuthorization } from "../access";
import type { AcceptSessionUserMessageDependencies } from "../dependencies";
import { acceptSessionUserMessageWithOutcome } from "../domain/sessions";

export type SubmitComposerDraftForRequestOptions = {
  authorization?: AccessGrantAuthorization | undefined;
  /**
   * Trusted host-owned resources admitted with this command without writing
   * them into the actor's browser-visible draft first. The saved draft remains
   * the exact content fence for actor-owned text, annotations, resources, and
   * execution policy; these resources participate in the accepted command's
   * idempotency hash, validation, turn, and durable session resource set.
   */
  additionalResources?: ResourceRef[] | undefined;
};

/**
 * Atomically accept one established-session composer draft.
 *
 * This is the application boundary shared by the stock HTTP adapter and an
 * in-process embedding host. A host may prepare its own durable business state
 * before calling this function and project the returned receipt afterward, but
 * OpenGeni remains the sole authority for draft validation/rotation, event
 * append, turn creation, routing, and idempotent replay.
 */
export async function submitComposerDraftForRequest(
  deps: AcceptSessionUserMessageDependencies,
  grant: AccessGrant,
  workspaceId: string,
  sessionId: string,
  input: SubmitComposerDraftRequest,
  options: SubmitComposerDraftForRequestOptions = {},
): Promise<SubmitComposerDraftResponse> {
  const additionalResources = options.additionalResources ?? [];
  const result = await acceptSessionUserMessageWithOutcome(deps, grant, workspaceId, sessionId, {
    text: input.text,
    annotations: input.annotations,
    modelContext: input.modelContext ?? null,
    resources: [...input.resources, ...additionalResources],
    ...(additionalResources.length > 0 ? { composerDraftResources: input.resources } : {}),
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    latencyMode: input.latencyMode,
    mcpCredentialUpdates: input.mcpCredentialUpdates ?? [],
    connectionAuthorities: input.connectionAuthorities,
    ...(input.personalResourceAttachment
      ? { personalResourceAttachment: input.personalResourceAttachment }
      : {}),
    ...(options.authorization ? { authorization: options.authorization } : {}),
    delivery: input.delivery,
    origin: "human",
    expectedDraftRevision: input.expectedDraftRevision,
    clientEventId: input.clientEventId,
    ...(input.controlEtag ? { controlEtag: input.controlEtag } : {}),
  });

  if (!result.draft) {
    throw new Error("Accepted composer draft submission did not return its next draft");
  }

  return {
    accepted: result.accepted,
    turn: result.turn,
    draft: result.draft,
    receipt: result.receipt,
    routing: result.routing,
    interruptionCount: result.interruptionCount,
    replay: result.replay,
  };
}
