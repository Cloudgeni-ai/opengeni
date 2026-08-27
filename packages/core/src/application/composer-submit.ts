import type {
  AccessGrant,
  SubmitComposerDraftRequest,
  SubmitComposerDraftResponse,
} from "@opengeni/contracts";
import type { AccessGrantAuthorization } from "../access";
import type { AcceptSessionUserMessageDependencies } from "../dependencies";
import { acceptSessionUserMessageWithOutcome } from "../domain/sessions";

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
  authorization?: AccessGrantAuthorization,
): Promise<SubmitComposerDraftResponse> {
  const result = await acceptSessionUserMessageWithOutcome(deps, grant, workspaceId, sessionId, {
    text: input.text,
    annotations: input.annotations,
    modelContext: input.modelContext ?? null,
    resources: input.resources,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    latencyMode: input.latencyMode,
    mcpCredentialUpdates: input.mcpCredentialUpdates ?? [],
    connectionAuthorities: input.connectionAuthorities,
    ...(input.personalResourceAttachment
      ? { personalResourceAttachment: input.personalResourceAttachment }
      : {}),
    ...(authorization ? { authorization } : {}),
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
