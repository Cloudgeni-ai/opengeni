import { sql } from "drizzle-orm";
import { evaluateWorkspaceModelPolicy, SubscriptionPersonalAuthorityV2 } from "@opengeni/contracts";
import type { ModelDescriptor, PlacementInput, ReselectionPoint } from "@opengeni/subscriptions";
import { rawRows, withRlsContext, withSessionRlsActorContext, type Database } from "./database";
import {
  assertSubscriptionTurnLeaseCurrent,
  listSubscriptionConnectionsForPlacement,
  readSubscriptionEffectiveSettings,
  readSubscriptionSessionBinding,
} from "./subscription-core-repository";
import { subscriptionCoreProviderId, type SubscriptionCoreProvider } from "./subscription-core/provider";

const CORE_SUBSCRIPTION_SUBJECT = "service:subscription-core";

export type SubscriptionCorePlacementWorldRequest = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  sessionOwnerSubjectId: string | null;
  sessionOwnerMembershipId: string | null;
  initiatingHumanSubjectId: string | null;
  /** Parsed immutable v2 value read from this exact accepted turn, never recomputed. */
  acceptedAuthorityV2: SubscriptionPersonalAuthorityV2;
  preferredModelId: string;
  reasoningLevel: string;
  models: readonly ModelDescriptor[];
  reselectionPoints: readonly ReselectionPoint[];
  now: Date;
};

export type SubscriptionCorePlacementWorldResult<T> =
  | { status: "not_visible" }
  | { status: "completed"; value: T };

export type SubscriptionCoreAcceptedTurnIdentity = Pick<
  SubscriptionCorePlacementWorldRequest,
  | "accountId"
  | "workspaceId"
  | "sessionId"
  | "turnId"
  | "sessionOwnerSubjectId"
  | "sessionOwnerMembershipId"
  | "initiatingHumanSubjectId"
>;

export type SubscriptionCoreAcceptedTurnAccessResult<T> =
  | { status: "not_visible" }
  | { status: "completed"; value: T };

export type SubscriptionCoreRefreshResult<T> =
  | { status: "not_visible" }
  | { status: "lease_lost" }
  | { status: "refused" }
  | { status: "completed"; value: T };

/** The credential a refresh callback rotates, read under the refresh lock. */
export type SubscriptionCoreRefreshCredential = {
  refreshGeneration: number;
  credentialEncrypted: string;
  expiresAt: Date | null;
};

type SessionPlacementRow = {
  owner_subject_id: string | null;
  owner_membership_id: string | null;
  initiating_human_subject_id: string | null;
  visibility: string;
  compaction_locked: boolean;
  workspace_kind: string;
  allowed_providers: string[] | null;
  allowed_models: string[] | null;
};

/**
 * Load one provider's placement world and run the caller's placement/lease
 * operation in the same tenant- and session-scoped transaction. Database
 * authorization functions establish access from the exact accepted turn;
 * callers cannot use this as a general account or session reader.
 */
export async function withSubscriptionCoreProviderPlacementWorld<T>(
  db: Database,
  provider: SubscriptionCoreProvider,
  request: SubscriptionCorePlacementWorldRequest,
  operation: (tx: Database, input: PlacementInput) => Promise<T>,
): Promise<SubscriptionCorePlacementWorldResult<T>> {
  const providerId = subscriptionCoreProviderId(provider);
  const acceptedAuthority = SubscriptionPersonalAuthorityV2.parse(request.acceptedAuthorityV2);
  return await withSubscriptionCoreAcceptedTurn(db, request, async (tx) => {
    const [session] = await rawRows<SessionPlacementRow>(
      tx,
      sql`select session.owner_subject_id,
                session.owner_organization_membership_id::text as owner_membership_id,
                turn.initiating_human_subject_id,
                session.visibility,
                ${provider.sessionCompactionLock ?? sql`false`} as compaction_locked,
                get_workspace_kind(workspace.account_id, workspace.id) as workspace_kind,
                -- The workspace's own policy, else its organization's default.
                case when policy.workspace_id is not null then policy.allowed_providers
                  else organization_defaults.allowed_providers end as allowed_providers,
                case when policy.workspace_id is not null then policy.allowed_models
                  else organization_defaults.allowed_models end as allowed_models
              from sessions session
              join session_turns turn on turn.account_id = session.account_id
                and turn.workspace_id = session.workspace_id and turn.session_id = session.id
              join workspaces workspace on workspace.account_id = session.account_id
                and workspace.id = session.workspace_id
              left join workspace_model_policies policy on policy.workspace_id = workspace.id
              left join organization_model_defaults organization_defaults
                on organization_defaults.account_id = workspace.account_id
              where session.account_id = ${request.accountId}::uuid
                and session.workspace_id = ${request.workspaceId}::uuid
                and session.id = ${request.sessionId}::uuid
                and turn.id = ${request.turnId}::uuid
              limit 1`,
    );
    if (!session) {
      throw new Error("Accepted subscription session disappeared during placement");
    }
    const personalAuthority =
      acceptedAuthority.personal.find((authority) => authority.provider === providerId) ?? null;
    let personalAuthorityAuthorized = false;
    if (
      personalAuthority &&
      session.owner_subject_id &&
      session.owner_membership_id === personalAuthority.ownerMembershipId &&
      request.initiatingHumanSubjectId
    ) {
      const [authorization] = await rawRows<{ authorized: boolean }>(
        tx,
        sql`select opengeni_private.authorize_subscription_personal_placement_access(
                ${request.accountId}::uuid, ${request.workspaceId}::uuid,
                ${request.sessionId}::uuid, ${request.turnId}::uuid, ${providerId},
                ${personalAuthority.ownerMembershipId}::uuid,
                ${personalAuthority.authorityGeneration}::bigint,
                ${session.owner_subject_id}, ${request.initiatingHumanSubjectId}
              ) as authorized`,
      );
      personalAuthorityAuthorized = authorization?.authorized === true;
    }

    const [effectiveSettings, binding, workspacePolicy, connectionRows] = await Promise.all([
      readSubscriptionEffectiveSettings(tx, request.accountId, request.workspaceId),
      readSubscriptionSessionBinding(tx, {
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
      }),
      {
        allowedProviders: session.allowed_providers,
        allowedModels: session.allowed_models,
      },
      listSubscriptionConnectionsForPlacement(tx, {
        accountId: request.accountId,
        workspaceId: request.workspaceId,
        provider: providerId,
        now: request.now,
      }),
    ]);

    let people: PlacementInput["people"] = [];
    if (session.owner_membership_id) {
      const [preference] = await rawRows<{ personal_fallback_opt_in: boolean }>(
        tx,
        sql`select personal_fallback_opt_in
              from subscription_person_preferences
              where account_id = ${request.accountId}::uuid
                and organization_membership_id = ${session.owner_membership_id}::uuid
              limit 1`,
      );
      // The exact accepted-turn gate above established that a non-null owner
      // membership is active. Runtime roles intentionally cannot read the
      // organization_memberships table directly; preferences remain
      // independently scoped by FORCE RLS and default to false when absent.
      people = [
        {
          membershipId: session.owner_membership_id,
          active: true,
          personalFallbackOptIn: preference?.personal_fallback_opt_in ?? false,
        },
      ];
    }

    const workspaceKind = session.workspace_kind === "personal" ? "personal" : "shared";
    const workspaceAllowedModelIds =
      workspacePolicy.allowedProviders === null && workspacePolicy.allowedModels === null
        ? null
        : request.models
            .filter(
              (model) =>
                evaluateWorkspaceModelPolicy(workspacePolicy, {
                  // Workspace model policy uses the resolved provider identity;
                  // the subscription core's provider key is intentionally neutral.
                  providerId:
                    model.provider === providerId
                      ? provider.adapter.modelPolicyProviderId
                      : model.provider,
                  modelId: model.id,
                }).allowed,
            )
            .map((model) => model.id);
    const input: PlacementInput = {
      now: request.now.getTime(),
      workspace: {
        id: request.workspaceId,
        kind: workspaceKind,
        ownerMembershipId: workspaceKind === "personal" ? session.owner_membership_id : null,
        allowedModelIds: workspaceAllowedModelIds,
      },
      session: {
        id: request.sessionId,
        workspaceId: request.workspaceId,
        visibility: session.visibility === "user_private" ? "private" : "shared",
        ownerMembershipId: session.owner_membership_id,
        preferredModelId: request.preferredModelId,
        reasoningLevel: request.reasoningLevel,
        binding: binding?.connectionId
          ? {
              connectionId: binding.connectionId,
              provider: binding.provider,
              modelId: binding.modelId,
              choice: binding.choice,
              lastModelCallAt: binding.lastModelCallAt?.getTime() ?? 0,
            }
          : null,
        onlyThisModel: binding?.onlyThisModel ?? false,
        reselectionPoints: request.reselectionPoints,
        personalAuthority:
          personalAuthorityAuthorized && personalAuthority
            ? [
                {
                  provider: personalAuthority.provider,
                  ownerMembershipId: personalAuthority.ownerMembershipId,
                },
              ]
            : [],
        compactionProviderLock: session.compaction_locked ? providerId : null,
      },
      settings: effectiveSettings.values,
      people,
      // Keep the complete catalog so a disallowed preferred model does not
      // erase provider metadata needed to evaluate same-provider fallback.
      models: request.models,
      connections: connectionRows,
      cacheFacts: { [providerId]: provider.adapter.cacheFacts },
    };
    return await operation(tx, input);
  });
}

/**
 * Reusable exact-turn gate for provider-neutral placement and secret-bearing
 * operations. Call it inside the caller's already tenant/session-scoped RLS
 * transaction; a successful result proves both the DB capability and the
 * request's session-owner tuple match the immutable accepted turn.
 */
export async function assertSubscriptionCoreAcceptedTurn(
  tx: Database,
  request: SubscriptionCoreAcceptedTurnIdentity,
): Promise<boolean> {
  const [authorization] = await rawRows<{ authorized: boolean }>(
    tx,
    // An ownerless session is shared-only whoever started the turn: a person's
    // turn there (for example a scheduled run that opens a new session) gets
    // the same shared-scope access as a service turn and no personal access.
    !request.sessionOwnerSubjectId
      ? sql`select opengeni_private.authorize_subscription_ownerless_session_access(
          ${request.accountId}::uuid, ${request.workspaceId}::uuid,
          ${request.sessionId}::uuid, ${request.turnId}::uuid
        ) as authorized`
      : request.initiatingHumanSubjectId
        ? sql`select opengeni_private.authorize_subscription_session_access(
            ${request.accountId}::uuid, ${request.workspaceId}::uuid,
            ${request.sessionId}::uuid, ${request.turnId}::uuid,
            ${request.sessionOwnerSubjectId}, ${request.initiatingHumanSubjectId}
          ) as authorized`
        : sql`select opengeni_private.authorize_subscription_service_session_access(
            ${request.accountId}::uuid, ${request.workspaceId}::uuid,
            ${request.sessionId}::uuid, ${request.turnId}::uuid,
            ${request.sessionOwnerSubjectId}
          ) as authorized`,
  );
  if (authorization?.authorized !== true) return false;

  const [session] = await rawRows<{
    owner_subject_id: string | null;
    owner_membership_id: string | null;
    initiating_human_subject_id: string | null;
    visibility: string;
  }>(
    tx,
    sql`select session.owner_subject_id,
        session.owner_organization_membership_id::text as owner_membership_id,
        turn.initiating_human_subject_id, session.visibility
      from sessions session
      join session_turns turn on turn.account_id = session.account_id
        and turn.workspace_id = session.workspace_id and turn.session_id = session.id
      where session.account_id = ${request.accountId}::uuid
        and session.workspace_id = ${request.workspaceId}::uuid
        and session.id = ${request.sessionId}::uuid
        and turn.id = ${request.turnId}::uuid
      limit 1`,
  );
  if (!session) return false;
  if (
    session.owner_subject_id !== request.sessionOwnerSubjectId ||
    session.owner_membership_id !== request.sessionOwnerMembershipId ||
    session.initiating_human_subject_id !== request.initiatingHumanSubjectId
  ) {
    throw new Error("Accepted subscription turn authority does not match its session");
  }
  if (session.owner_subject_id === null && session.visibility === "user_private") {
    throw new Error("An ownerless subscription session cannot be private");
  }
  return true;
}

/**
 * Establish the core service actor and exact tenant/session RLS transaction,
 * then run an operation only for the immutable accepted turn. Secret-bearing
 * consumers should use this wrapper rather than opening workspace-only RLS.
 */
export async function withSubscriptionCoreAcceptedTurn<T>(
  db: Database,
  request: SubscriptionCoreAcceptedTurnIdentity,
  operation: (tx: Database) => Promise<T>,
): Promise<SubscriptionCoreAcceptedTurnAccessResult<T>> {
  const actorInitiatingHuman = request.sessionOwnerSubjectId
    ? (request.initiatingHumanSubjectId ?? request.sessionOwnerSubjectId)
    : null;
  return await withSessionRlsActorContext(
    {
      subjectId: CORE_SUBSCRIPTION_SUBJECT,
      initiatingHumanSubjectId: actorInitiatingHuman,
    },
    async () =>
      await withRlsContext(
        db,
        { accountId: request.accountId, workspaceId: request.workspaceId },
        async (tx) => {
          if (!(await assertSubscriptionCoreAcceptedTurn(tx, request))) {
            return { status: "not_visible" } as const;
          }
          return { status: "completed", value: await operation(tx) } as const;
        },
      ),
  );
}

/**
 * Serialize one connection's credential refresh under the canonical
 * per-connection lock, while requiring both exact accepted-turn access and
 * its live lease generation in the same RLS transaction.
 *
 * Authorization happens once, before the callback's provider call, through
 * begin_subscription_core_refresh. The callback receives the credential to
 * rotate and must call persistSubscriptionCoreRefresh as soon as the
 * provider returns, before any other fallible work: a rolled-back
 * transaction discards the rotated credential. Persistence no longer depends
 * on the lease or visibility surviving the provider call.
 */
export async function withSubscriptionCoreRefreshLock<T>(
  db: Database,
  provider: SubscriptionCoreProvider,
  request: SubscriptionCoreAcceptedTurnIdentity & {
    connectionId: string;
    holderId: string;
    generation: number;
  },
  operation: (tx: Database, credential: SubscriptionCoreRefreshCredential) => Promise<T>,
): Promise<SubscriptionCoreRefreshResult<T>> {
  const providerId = subscriptionCoreProviderId(provider);
  const access = await withSubscriptionCoreAcceptedTurn(db, request, async (tx) => {
    const leaseIsCurrent = await assertSubscriptionTurnLeaseCurrent(tx, {
      accountId: request.accountId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      provider: providerId,
      connectionId: request.connectionId,
      holderId: request.holderId,
      generation: request.generation,
    });
    if (!leaseIsCurrent) return { status: "lease_lost" } as const;
    await tx.execute(sql`set local lock_timeout = '30s'`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtextextended(${`subscription-refresh:${request.connectionId}`}, 0)
      )`,
    );
    const leaseStillCurrent = await assertSubscriptionTurnLeaseCurrent(tx, {
      accountId: request.accountId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      provider: providerId,
      connectionId: request.connectionId,
      holderId: request.holderId,
      generation: request.generation,
    });
    if (!leaseStillCurrent) return { status: "lease_lost" } as const;
    const [credential] = await rawRows<{
      refresh_generation: number | string;
      credential_encrypted: string;
      expires_at: Date | string | null;
    }>(
      tx,
      sql`select refresh_generation, credential_encrypted, expires_at
        from opengeni_private.begin_subscription_core_refresh(${providerId},
          ${request.accountId}::uuid, ${request.workspaceId}::uuid,
          ${request.sessionId}::uuid, ${request.turnId}::uuid,
          ${request.sessionOwnerSubjectId}, ${request.initiatingHumanSubjectId},
          ${request.connectionId}::uuid, ${request.holderId}, ${request.generation}::bigint
        )`,
    );
    if (!credential) return { status: "refused" } as const;
    return {
      status: "locked",
      value: await operation(tx, {
        refreshGeneration: Number(credential.refresh_generation),
        credentialEncrypted: credential.credential_encrypted,
        expiresAt: credential.expires_at === null ? null : new Date(credential.expires_at),
      }),
    } as const;
  });
  if (access.status === "not_visible") return access;
  if (access.value.status === "lease_lost") return access.value;
  if (access.value.status === "refused") return access.value;
  return { status: "completed", value: access.value.value };
}
