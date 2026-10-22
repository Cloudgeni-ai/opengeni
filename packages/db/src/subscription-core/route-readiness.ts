/**
 * Funding and readiness of a connected subscription by its provider's route
 * (design 5.3, EP-N19 and EP-T18/EP-S25/EP-N26), for any provider whose
 * callers have not moved to the core unconditionally. A provider without a
 * legacy route keeps its own M3 predicates.
 *
 * - `legacy` (no cutover receipt): the caller keeps its legacy answer; the
 *   core is never read.
 * - `maintenance`: not funded and not ready (fail closed).
 * - `core`: the core's answer for the registered binding. An accepted turn
 *   is funded exactly as placement would serve it (its frozen authority,
 *   session owner and model); new work in a workspace is funded or ready
 *   when a connection that may serve the acting subject here admits the
 *   model (shared pools; the subject's own personal connection only in
 *   their own Personal workspace).
 */
import type { Database } from "../database";
import { subscriptionCoreProvider } from "../subscription-core-providers";
import {
  listSubscriptionCoreServingConnections,
  subscriptionCoreConnectionAllowlist,
  subscriptionCoreConnectionAllowsModel,
} from "./catalog";
import { readSubscriptionCoreProviderRouteForWorkspace } from "./provider-route";
import { subscriptionCoreTurns } from "./turns";

export type SubscriptionCoreRouteAnswer<T> = { route: "legacy" } | { route: "core"; value: T };

type Scope = {
  provider: string;
  accountId: string;
  workspaceId: string;
  /** The acting person (or a scheduled task's owner); null sees shared capacity only. */
  subjectId: string | null;
};

/** Whether the provider's subscription funds this work, or `legacy` to keep the legacy answer. */
export async function readSubscriptionCoreRouteFunding(
  db: Database,
  input: Scope & {
    productModelId: string;
    /** The exact accepted work, when the caller has it. */
    acceptedTurn?: { sessionId: string; turnId: string };
  },
): Promise<SubscriptionCoreRouteAnswer<boolean>> {
  const route = await readSubscriptionCoreProviderRouteForWorkspace(db, input);
  if (route === "legacy") return { route: "legacy" };
  if (route === "maintenance") return { route: "core", value: false };
  // Throws for a provider missing from the registry: fail closed.
  const binding = subscriptionCoreProvider(input.provider);
  if (input.acceptedTurn) {
    return {
      route: "core",
      value: await subscriptionCoreTurns(binding).subscriptionCoreAcceptedTurnIsFunded(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        ...input.acceptedTurn,
        productModelId: input.productModelId,
      }),
    };
  }
  const serving = await listSubscriptionCoreServingConnections(db, binding, input);
  return {
    route: "core",
    value: serving.some((connection) =>
      subscriptionCoreConnectionAllowsModel(connection, input.productModelId),
    ),
  };
}

/**
 * The provider's catalog readiness here and the union of its serving
 * connections' model allowlists (null: every model), or `legacy`.
 */
export async function readSubscriptionCoreRouteReadiness(
  db: Database,
  input: Scope,
): Promise<SubscriptionCoreRouteAnswer<{ ready: boolean; allowedModelIds: string[] | null }>> {
  const route = await readSubscriptionCoreProviderRouteForWorkspace(db, input);
  if (route === "legacy") return { route: "legacy" };
  if (route === "maintenance")
    return { route: "core", value: { ready: false, allowedModelIds: [] } };
  const serving = await listSubscriptionCoreServingConnections(
    db,
    subscriptionCoreProvider(input.provider),
    input,
  );
  const allowlists = serving.map(subscriptionCoreConnectionAllowlist);
  return {
    route: "core",
    value: {
      ready: serving.length > 0,
      allowedModelIds: allowlists.some((allowed) => allowed === null)
        ? null
        : [...new Set(allowlists.flatMap((allowed) => allowed ?? []))].sort(),
    },
  };
}
