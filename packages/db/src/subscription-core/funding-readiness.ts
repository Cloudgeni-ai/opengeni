/**
 * Funding and readiness of a connected subscription on the shared core
 * (design 5.3, EP-N19 and EP-T18/EP-S25/EP-N26) for the registered binding.
 * An accepted turn is funded exactly as placement would serve it (its frozen
 * authority, session owner and model); new work in a workspace is funded or
 * ready when a connection that may serve the acting subject here admits the
 * model (shared pools; the subject's own personal connection only in their
 * own Personal workspace).
 */
import type { Database } from "../database";
import { subscriptionCoreProvider } from "../subscription-core-providers";
import {
  listSubscriptionCoreServingConnections,
  subscriptionCoreConnectionAllowlist,
  subscriptionCoreConnectionAllowsModel,
} from "./catalog";
import { subscriptionCoreTurns } from "./turns";

type Scope = {
  provider: string;
  accountId: string;
  workspaceId: string;
  /** The acting person (or a scheduled task's owner); null sees shared capacity only. */
  subjectId: string | null;
};

/** Whether the provider's subscription funds this work. */
export async function readSubscriptionCoreFunding(
  db: Database,
  input: Scope & {
    productModelId: string;
    /** The exact accepted work, when the caller has it. */
    acceptedTurn?: { sessionId: string; turnId: string };
  },
): Promise<boolean> {
  // Throws for a provider missing from the registry: fail closed.
  const binding = subscriptionCoreProvider(input.provider);
  if (input.acceptedTurn) {
    return await subscriptionCoreTurns(binding).subscriptionCoreAcceptedTurnIsFunded(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      ...input.acceptedTurn,
      productModelId: input.productModelId,
    });
  }
  const serving = await listSubscriptionCoreServingConnections(db, binding, input);
  return serving.some((connection) =>
    subscriptionCoreConnectionAllowsModel(connection, input.productModelId),
  );
}

/**
 * The provider's catalog readiness here and the union of its serving
 * connections' model allowlists (null: every model).
 */
export async function readSubscriptionCoreReadiness(
  db: Database,
  input: Scope,
): Promise<{ ready: boolean; allowedModelIds: string[] | null }> {
  const serving = await listSubscriptionCoreServingConnections(
    db,
    subscriptionCoreProvider(input.provider),
    input,
  );
  const allowlists = serving.map(subscriptionCoreConnectionAllowlist);
  return {
    ready: serving.length > 0,
    allowedModelIds: allowlists.some((allowed) => allowed === null)
      ? null
      : [...new Set(allowlists.flatMap((allowed) => allowed ?? []))].sort(),
  };
}
