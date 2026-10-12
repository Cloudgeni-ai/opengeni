import { sql } from "drizzle-orm";
import {
  evaluateWorkspaceModelPolicy,
  readTurnExecutionPolicyV1,
  SubscriptionPersonalAuthorityV2,
} from "@opengeni/contracts";
import {
  declaredCacheLifetimeMs,
  failoverCandidateModels,
  modelPermitted,
  personalFallbackActive,
  subscriptionCoreModelPolicyProviderIds,
  type ModelDescriptor,
  type PlacementInput,
} from "@opengeni/subscriptions";
import { rawRows, type Database } from "../database";
import { withSubscriptionCoreAcceptedTurn } from "../subscription-core-placement-world";
import {
  listSubscriptionConnectionsForPlacement,
  readSubscriptionEffectiveSettings,
  readSubscriptionSessionBinding,
  type SubscriptionSessionBinding,
} from "../subscription-core-repository";
import {
  subscriptionCoreProvider,
  subscriptionCoreProviderIds,
} from "../subscription-core-providers";
import {
  subscriptionCoreConnectionKind,
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "./provider";
import { readSubscriptionCoreServingPolicyForTurn } from "./serving-policy";
import { subscriptionCoreReselectionPoints, type SubscriptionCoreTurnIdentity } from "./turns";
import {
  readSubscriptionCoreFailoverProvider,
  subscriptionCoreBindingsPermitCrossing,
} from "./failover-readiness";

/** Trusted executable catalog from the caller's deployment configuration.
 * Tier declarations are read from the registered adapter, not caller guesses.
 */
export type SubscriptionCoreFailoverModel = ModelDescriptor & { upstreamModelId: string };
export type SubscriptionCoreFailoverWorldRequest = {
  identity: SubscriptionCoreTurnIdentity;
  productModelId: string;
  reasoningLevel: string;
  models: readonly SubscriptionCoreFailoverModel[];
  crossProviderFailoverEnabled?: boolean;
  quotaStaleAfterMs?: Readonly<Record<string, number>>;
  now?: Date;
};
export type SubscriptionCoreFailoverWorld = {
  input: PlacementInput;
  providers: ReadonlyMap<string, SubscriptionCoreProvider>;
  bindings: ReadonlyMap<string, SubscriptionSessionBinding | null>;
  serving: { provider: string; modelId: string; thisTurn: boolean };
  candidateProviders: string[];
};

export function policyBinding(
  binding: SubscriptionSessionBinding | null,
): PlacementInput["session"]["binding"] {
  return binding?.connectionId
    ? {
        connectionId: binding.connectionId,
        provider: binding.provider,
        modelId: binding.modelId,
        choice: binding.choice,
        lastModelCallAt: binding.lastModelCallAt?.getTime() ?? 0,
      }
    : null;
}

/** C1 is the only serving metadata reader. A previous turn with no receipt
 * ends continuity; never search further back for a more convenient fallback.
 */
export async function readSubscriptionCoreServingContinuity(
  tx: Database,
  identity: SubscriptionCoreTurnIdentity,
  homeProvider: string,
  acceptedModel: string,
  models: readonly SubscriptionCoreFailoverModel[],
): Promise<SubscriptionCoreFailoverWorld["serving"]> {
  const home = { provider: homeProvider, modelId: acceptedModel, thisTurn: false };
  const current = await readSubscriptionCoreServingPolicyForTurn(tx, identity);
  if (current === null) throw new Error("Accepted turn disappeared during serving read");
  if (current.kind === "valid") {
    const latest = current.revisions.at(-1)!;
    return {
      provider:
        models.find((model) => model.id === latest.policy.productModelId)?.provider ??
        latest.policy.providerId,
      modelId: latest.policy.productModelId,
      thisTurn: true,
    };
  }
  const [previous] = await rawRows<{ id: string; metadata: Record<string, unknown> }>(
    tx,
    sql`
    select prior.id::text, prior.metadata from session_turns prior
    join session_turns current on current.account_id = prior.account_id
      and current.workspace_id = prior.workspace_id and current.session_id = prior.session_id
    where current.account_id = ${identity.accountId}::uuid
      and current.workspace_id = ${identity.workspaceId}::uuid
      and current.session_id = ${identity.sessionId}::uuid and current.id = ${identity.turnId}::uuid
      and prior.position < current.position and prior.metadata ? 'turnExecutionPolicyV1'
    order by prior.position desc limit 1`,
  );
  if (!previous) return home;
  const policy = readTurnExecutionPolicyV1(previous.metadata);
  if (policy.kind !== "valid" || policy.policy.productModelId !== acceptedModel) return home;
  const stored = await readSubscriptionCoreServingPolicyForTurn(tx, {
    ...identity,
    turnId: previous.id,
  });
  if (stored?.kind !== "valid") return home;
  const latest = stored.revisions.at(-1)!;
  return {
    provider:
      models.find((model) => model.id === latest.policy.productModelId)?.provider ??
      latest.policy.providerId,
    modelId: latest.policy.productModelId,
    thisTurn: false,
  };
}

/** Parity copy of turns.ts until the M4 stacks can share this read. */
export async function readLastContextReplacedAt(
  tx: Database,
  identity: SubscriptionCoreTurnIdentity,
): Promise<number | null> {
  const [row] = await rawRows<{ replaced_at: Date | string | null }>(
    tx,
    sql`select greatest(
    (select occurred_at from session_events where workspace_id = ${identity.workspaceId}::uuid
      and session_id = ${identity.sessionId}::uuid and type = 'session.context.compacted'
      order by sequence desc limit 1),
    (select occurred_at from session_events where workspace_id = ${identity.workspaceId}::uuid
      and session_id = ${identity.sessionId}::uuid and type = 'session.context.cleared'
      order by sequence desc limit 1)) as replaced_at`,
  );
  return row?.replaced_at == null ? null : new Date(row.replaced_at).getTime();
}

/** D-33/D-46 world. All binding locks precede every connection lock. The
 * callback may acquire ONE lease, but must NEVER call a serving/pending/event
 * writer: its turn UPDATE fence inverts reservation's turn SHARE -> binding
 * order. Those writes belong in a separate transaction after this commits.
 */
export async function withSubscriptionCoreFailoverPlacementWorld<T>(
  db: Database,
  home: SubscriptionCoreProvider,
  request: SubscriptionCoreFailoverWorldRequest,
  lockBindings: boolean,
  operation: (tx: Database, world: SubscriptionCoreFailoverWorld) => Promise<T>,
): Promise<
  { status: "home_only" } | { status: "not_visible" } | { status: "completed"; value: T }
> {
  if (request.crossProviderFailoverEnabled !== true) return { status: "home_only" };
  const homeId = subscriptionCoreProviderId(home);
  const { identity } = request;
  const authority = SubscriptionPersonalAuthorityV2.parse(identity.acceptedAuthorityV2);
  const result = await withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
    const [session] = await rawRows<{
      metadata: Record<string, unknown>;
      visibility: string;
      workspace_kind: string;
      allowed_providers: string[] | null;
      allowed_models: string[] | null;
    }>(
      tx,
      sql`select turn.metadata, session.visibility,
      get_workspace_kind(workspace.account_id, workspace.id) as workspace_kind,
      case when policy.workspace_id is not null then policy.allowed_providers
        else defaults.allowed_providers end as allowed_providers,
      case when policy.workspace_id is not null then policy.allowed_models
        else defaults.allowed_models end as allowed_models
      from sessions session join session_turns turn on turn.account_id = session.account_id
        and turn.workspace_id = session.workspace_id and turn.session_id = session.id
      join workspaces workspace on workspace.account_id = session.account_id and workspace.id = session.workspace_id
      left join workspace_model_policies policy on policy.workspace_id = workspace.id
      left join organization_model_defaults defaults on defaults.account_id = workspace.account_id
      where session.account_id = ${identity.accountId}::uuid and session.workspace_id = ${identity.workspaceId}::uuid
        and session.id = ${identity.sessionId}::uuid and turn.id = ${identity.turnId}::uuid`,
    );
    if (!session) throw new Error("Accepted subscription session disappeared during placement");
    const accepted = readTurnExecutionPolicyV1(session.metadata);
    if (
      accepted.kind !== "valid" ||
      accepted.policy.credentialRestriction !== undefined ||
      accepted.policy.productModelId !== request.productModelId ||
      !subscriptionCoreModelPolicyProviderIds(home.adapter, request.productModelId).includes(
        accepted.policy.providerId,
      )
    )
      return { status: "home_only" } as const;
    if (!(await readSubscriptionCoreFailoverProvider(tx, identity.accountId, homeId)))
      return { status: "home_only" } as const;
    const effective = await readSubscriptionEffectiveSettings(
      tx,
      identity.accountId,
      identity.workspaceId,
    );
    const crossing =
      effective.values.crossProviderFailover && (await subscriptionCoreBindingsPermitCrossing(tx));
    const providers = new Map<string, SubscriptionCoreProvider>();
    for (const id of subscriptionCoreProviderIds()) {
      if (id !== homeId && !crossing) continue;
      const registered = await readSubscriptionCoreFailoverProvider(tx, identity.accountId, id);
      if (registered) providers.set(id, registered);
    }
    if (!providers.has(homeId)) return { status: "home_only" } as const;
    if (new Set(request.models.map((model) => model.id)).size !== request.models.length)
      throw new Error("Duplicate failover catalog model");
    const models = request.models
      .filter((model) => providers.has(model.provider))
      .map((model) => {
        if (!model.upstreamModelId || !model.reasoningLevels.length)
          throw new Error("Incomplete failover model definition");
        const tier = providers.get(model.provider)!.adapter.modelTier?.(model.id);
        const { tier: _ignored, ...descriptor } = model;
        return { ...descriptor, ...(tier ? { tier } : {}) };
      });
    const preferred = models.find((model) => model.id === request.productModelId);
    if (
      !preferred ||
      preferred.provider !== homeId ||
      preferred.upstreamModelId !== accepted.policy.upstreamModelId
    )
      return { status: "home_only" } as const;
    const workspacePolicy = {
      allowedProviders: session.allowed_providers,
      allowedModels: session.allowed_models,
    };
    const kind = session.workspace_kind === "personal" ? "personal" : "shared";
    const input: PlacementInput = {
      now: (request.now ?? new Date()).getTime(),
      workspace: {
        id: identity.workspaceId,
        kind,
        ownerMembershipId: kind === "personal" ? identity.sessionOwnerMembershipId : null,
        allowedModelIds:
          session.allowed_providers === null && session.allowed_models === null
            ? null
            : models
                .filter((model) =>
                  subscriptionCoreModelPolicyProviderIds(
                    providers.get(model.provider)!.adapter,
                    model.id,
                  ).every(
                    (providerId) =>
                      evaluateWorkspaceModelPolicy(workspacePolicy, {
                        providerId,
                        modelId: model.id,
                        chargesCredits: false,
                      }).allowed,
                  ),
                )
                .map((model) => model.id),
      },
      session: {
        id: identity.sessionId,
        workspaceId: identity.workspaceId,
        visibility: session.visibility === "user_private" ? "private" : "shared",
        ownerMembershipId: identity.sessionOwnerMembershipId,
        preferredModelId: request.productModelId,
        reasoningLevel: request.reasoningLevel,
        binding: null,
        onlyThisModel: false,
        reselectionPoints: [],
        personalAuthority: [],
        compactionProviderLock: null,
      },
      settings: { ...effective.values, crossProviderFailover: crossing },
      people: [],
      models,
      connections: [],
      cacheFacts: {},
      ...(request.quotaStaleAfterMs ? { quotaStaleAfterMs: request.quotaStaleAfterMs } : {}),
    };
    // Every registered compaction lock matters, including a held/noncandidate
    // provider: it cannot disappear just because its route is unavailable.
    for (const id of subscriptionCoreProviderIds()) {
      const expression = subscriptionCoreProvider(id).sessionCompactionLock;
      if (!expression) continue;
      const [row] = await rawRows<{ locked: boolean }>(
        tx,
        sql`select ${expression} as locked from sessions session
        where session.account_id = ${identity.accountId}::uuid and session.workspace_id = ${identity.workspaceId}::uuid
          and session.id = ${identity.sessionId}::uuid`,
      );
      if (row?.locked) {
        if (input.session.compactionProviderLock && input.session.compactionProviderLock !== id)
          throw new Error("Conflicting compaction provider locks");
        input.session.compactionProviderLock = id;
      }
    }
    const candidates = failoverCandidateModels(input);
    const candidateIds = [
      ...new Set(
        models
          // Keep locked-out capacity in the world so policy can explain a
          // compaction-only wait, but never offer it as a serving decision.
          .filter(
            (model) => candidates.includes(model.id) && modelPermitted(input, model.id, false),
          )
          .map((model) => model.provider),
      ),
    ].sort();
    const lockIds = [...new Set([homeId, ...candidateIds])].sort();
    const personal: Array<PlacementInput["session"]["personalAuthority"][number]> = [];
    for (const id of lockIds) {
      const entry = authority.personal.find((value) => value.provider === id);
      if (
        !entry ||
        !identity.sessionOwnerSubjectId ||
        !identity.initiatingHumanSubjectId ||
        entry.ownerMembershipId !== identity.sessionOwnerMembershipId
      )
        continue;
      const [row] = await rawRows<{ authorized: boolean }>(
        tx,
        sql`
        select opengeni_private.authorize_subscription_personal_placement_access(
          ${identity.accountId}::uuid, ${identity.workspaceId}::uuid, ${identity.sessionId}::uuid, ${identity.turnId}::uuid,
          ${id}, ${entry.ownerMembershipId}::uuid, ${entry.authorityGeneration}::bigint,
          ${identity.sessionOwnerSubjectId}, ${identity.initiatingHumanSubjectId}) as authorized`,
      );
      if (row?.authorized)
        personal.push({ provider: id, ownerMembershipId: entry.ownerMembershipId });
    }
    input.session.personalAuthority = personal;
    // A missing row cannot be protected by FOR UPDATE. Serialize B1's
    // first-insert decisions before ANY binding/connection lock: otherwise
    // one loser can hold a connection while another locks the newly inserted
    // binding and waits for that connection. Pins/reservations keep their
    // existing binding -> connection order and never acquire this lock.
    if (lockBindings)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
        ${`subscription-failover:${identity.workspaceId}:${identity.sessionId}`}, 0))`);
    const bindings = new Map<string, SubscriptionSessionBinding | null>();
    for (const id of lockIds)
      bindings.set(
        id,
        await readSubscriptionSessionBinding(tx, {
          ...identity,
          provider: id,
          forUpdate: lockBindings,
        }),
      );
    const homeBinding = bindings.get(homeId) ?? null;
    if (homeBinding?.choice === "explicit" || homeBinding?.onlyThisModel)
      return { status: "home_only" } as const;
    const serving = await readSubscriptionCoreServingContinuity(
      tx,
      identity,
      homeId,
      request.productModelId,
      request.models,
    );
    if (candidates.length <= 1 && serving.modelId === request.productModelId)
      return { status: "home_only" } as const;
    // Target pins filter only their provider, never authorize personal use.
    input.models = models.filter((model) => {
      const binding = bindings.get(model.provider);
      return (
        model.provider === homeId ||
        ((!binding?.onlyThisModel || binding.modelId === model.id) &&
          !(binding?.choice === "explicit" && binding.connectionId === null))
      );
    });
    for (const id of candidateIds) {
      const provider = providers.get(id)!;
      declaredCacheLifetimeMs(provider.adapter.cacheFacts);
      input.cacheFacts = { ...input.cacheFacts, [id]: provider.adapter.cacheFacts };
      const binding = bindings.get(id);
      const rows = await listSubscriptionConnectionsForPlacement(tx, {
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        provider: id,
        kind: subscriptionCoreConnectionKind(provider),
        now: new Date(input.now),
      });
      // Background work carries each provider's own frozen compatibility
      // pool. A live source change must not widen that accepted ceiling.
      // The reader is scoped to the exact accepted carrier, not a new
      // acceptance inferred from the current session owner.
      const [frozen] = await rawRows<{
        authority: { authority?: string; sharedPool?: string } | null;
      }>(
        tx,
        sql`select opengeni_private.read_subscription_authority_compat(
          ${id}, 'session_turn', ${identity.workspaceId}::uuid, ${identity.turnId}::uuid, null
        ) as authority`,
      );
      const snapshot = frozen?.authority;
      const unrestricted = snapshot?.authority === "v2" || snapshot?.authority === "none";
      const pool = snapshot?.authority === "record" ? snapshot.sharedPool : "none";
      const frozenRows = unrestricted
        ? rows
        : rows.flatMap((connection) => {
            if (connection.ownership.kind === "personal") return [connection];
            if (pool !== "workspace" && pool !== "organization") return [];
            if (connection.assignmentPolicies !== undefined) {
              const assignments = connection.assignmentPolicies.filter(
                (policy) =>
                  policy.workspaceId === identity.workspaceId && policy.inferencePool === pool,
              );
              return assignments.length ? [{ ...connection, assignmentPolicies: assignments }] : [];
            }
            const managedHere = connection.ownership.managedByWorkspaceId === identity.workspaceId;
            return (pool === "workspace" ? managedHere : !managedHere) ? [connection] : [];
          });
      input.connections = [
        ...input.connections,
        ...frozenRows
          .filter(
            (connection) =>
              id === homeId ||
              binding?.choice !== "explicit" ||
              binding.connectionId === connection.id,
          )
          .map((connection) => ({
            ...connection,
            extraCreditsEnabled:
              provider.adapter.capabilities.extraCredits && connection.extraCreditsEnabled === true,
            ...(connection.observedModelSlugs == null
              ? {}
              : {
                  entitledModelIds: models
                    .filter(
                      (model) =>
                        model.provider === id &&
                        connection.observedModelSlugs!.includes(model.upstreamModelId),
                    )
                    .map((model) => model.id),
                }),
          })),
      ];
    }
    if (identity.sessionOwnerMembershipId) {
      const [preference] = await rawRows<{ personal_fallback_opt_in: boolean }>(
        tx,
        sql`
        select personal_fallback_opt_in from subscription_person_preferences
        where account_id = ${identity.accountId}::uuid
          and organization_membership_id = ${identity.sessionOwnerMembershipId}::uuid limit 1`,
      );
      input.people = [
        {
          membershipId: identity.sessionOwnerMembershipId,
          active: true,
          personalFallbackOptIn: preference?.personal_fallback_opt_in ?? false,
        },
      ];
    }
    // A target's personal pin cannot bootstrap personal fallback permission.
    if (!personalFallbackActive(input))
      input.connections = input.connections.filter(
        (connection) => connection.provider === homeId || connection.ownership.kind === "shared",
      );
    const servingBinding = policyBinding(bindings.get(serving.provider) ?? null);
    input.session.binding = servingBinding ? { ...servingBinding, choice: "automatic" } : null;
    input.session.reselectionPoints = subscriptionCoreReselectionPoints({
      binding: input.session.binding,
      productModelId: serving.modelId,
      lastContextReplacedAt: input.session.binding
        ? await readLastContextReplacedAt(tx, identity)
        : null,
    });
    return {
      status: "completed",
      value: await operation(tx, {
        input,
        providers,
        bindings,
        serving,
        candidateProviders: candidateIds.filter((id) =>
          input.models.some(
            (model) =>
              model.provider === id &&
              candidates.includes(model.id) &&
              modelPermitted(input, model.id),
          ),
        ),
      }),
    } as const;
  });
  return result.status === "not_visible" ? result : result.value;
}
