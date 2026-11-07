import type {
  AccessGrant,
  ComposerDraft,
  ResourceRef,
  SubmitComposerDraftRequest,
  SubmitComposerDraftResponse,
} from "@opengeni/contracts";
import { getSession } from "@opengeni/db";
import type { AccessGrantAuthorization } from "../access";
import type { AcceptSessionUserMessageDependencies } from "../dependencies";
import { acceptSessionUserMessageWithOutcome } from "../domain/sessions";

export type SubmitComposerDraftForRequestOptions = {
  authorization?: AccessGrantAuthorization | undefined;
  /**
   * Trusted host-owned resources admitted with this command without writing
   * them into the actor's browser-visible draft first. They participate in
   * the accepted command's idempotency hash, validation, turn, and durable
   * session resource set.
   */
  additionalResources?: ResourceRef[] | undefined;
};

/**
 * Atomically accept one established-session composer draft.
 *
 * This is the application boundary shared by the stock HTTP adapter and an
 * in-process embedding host. A host may prepare its own durable business state
 * before calling this function and project the returned receipt afterward, but
 * Opengeni remains the sole authority for draft validation/rotation, event
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
    timeZone: input.timeZone ?? null,
    resources: [...input.resources, ...additionalResources],
    ...(additionalResources.length > 0 ? { composerDraftResources: input.resources } : {}),
    // A draft that follows the chat's settings is sent without them, so the
    // turn runs on the chat's current settings.
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.latencyMode !== undefined ? { latencyMode: input.latencyMode } : {}),
    mcpCredentialUpdates: input.mcpCredentialUpdates ?? [],
    connectionAccounts: input.connectionAccounts,

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

  // With no saved draft row there was nothing to clear: the person's draft
  // is the empty one a read returns, in the fresh and the replayed response.
  const draft = result.draft ?? (await emptyComposerDraft(deps, workspaceId, sessionId));

  return {
    accepted: result.accepted,
    turn: result.turn,
    draft,
    receipt: result.receipt,
    routing: result.routing,
    interruptionCount: result.interruptionCount,
    waitsForMachineOwner: result.waitsForMachineOwner,
    replay: result.replay,
  };
}

/** The draft a person has before saving one: empty, following the chat's settings. */
async function emptyComposerDraft(
  deps: AcceptSessionUserMessageDependencies,
  workspaceId: string,
  sessionId: string,
): Promise<ComposerDraft> {
  const session = await getSession(deps.db, workspaceId, sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return {
    revision: 0,
    text: "",
    annotations: [],
    resources: [],
    model: session.model,
    reasoningEffort: session.reasoningEffort as ComposerDraft["reasoningEffort"],
    latencyMode: session.latencyMode as ComposerDraft["latencyMode"],
    policyFollowsSession: true,
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: null,
  };
}
