import { sql } from "drizzle-orm";
import type { SharedTestDatabase } from "@opengeni/testing";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  withSessionRlsActorContext,
  applySessionTurnSettlement,
  requestSessionTurnRecovery,
} from "../../src";
import { withWorkspaceSubjectSessionActivityRls } from "../../src/database";
import {
  writeSubscriptionSessionBinding,
  readSubscriptionSessionBinding,
  releaseSubscriptionTurnLease,
} from "../../src/subscription-core-repository";
import { readSubscriptionCoreTurnIdentity } from "../../src/subscription-core/turns";
import type { SubscriptionCoreProvider } from "../../src/subscription-core/provider";
import type { SubscriptionCoreFailoverModel } from "../../src/subscription-core/failover-world";
import { withSubscriptionCoreAcceptedTurn } from "../../src/subscription-core-placement-world";

/** Own B1 fixture; shared conformance fixtures are intentionally not edited. */
export function failoverFixture(
  shared: SharedTestDatabase,
  providers: readonly SubscriptionCoreProvider[],
  models: readonly SubscriptionCoreFailoverModel[],
) {
  const client = createDb(shared.appUrl, { max: 12 });
  const admin = shared.admin;
  async function organization() {
    const userId = `failover-${crypto.randomUUID()}`;
    const accountId = (
      await ensureManagedAccessForUser(client.db, {
        userId,
        email: `${userId}@example.test`,
        name: "Failover fixture",
      })
    ).workspaceGrants[0]!.accountId;
    const subjectId = `user:${userId}`;
    const [membership] = await admin<{ id: string; personal_workspace_id: string }[]>`
      select id::text, personal_workspace_id::text from organization_memberships
      where account_id = ${accountId}::uuid and subject_id = ${subjectId} and status = 'active'`;
    const [workspace] = await admin<{ id: string }[]>`insert into workspaces(account_id, name)
      values (${accountId}::uuid, 'Failover shared') returning id::text`;
    const workspaceId = workspace!.id;
    await admin`insert into workspace_memberships(account_id, workspace_id, subject_id, role)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'owner')`;
    await admin`insert into workspace_inference_controls(account_id, workspace_id)
      values (${accountId}::uuid, ${workspaceId}::uuid)`;
    await admin`delete from subscription_settings where account_id = ${accountId}::uuid and workspace_id is null`;
    await admin`insert into subscription_settings(account_id, rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed) values
      (${accountId}::uuid, '{}'::jsonb, '{}'::jsonb, true, ${admin.json({ [models[0]!.id]: models.slice(1).map((model) => model.id) })}::jsonb, true, true)`;
    for (const provider of providers)
      await admin`insert into subscription_provider_cutovers(account_id, provider, enabled)
      values (${accountId}::uuid, ${provider.adapter.provider}, true) on conflict (account_id, provider) do update set enabled = true`;
    return {
      accountId,
      workspaceId,
      subjectId,
      membershipId: membership!.id,
      personalWorkspaceId: membership!.personal_workspace_id,
    };
  }
  async function connection(
    org: Awaited<ReturnType<typeof organization>>,
    provider: SubscriptionCoreProvider,
    options: {
      allowedModelIds?: string[];
      personal?: boolean;
      generation?: number;
    } = {},
  ) {
    const id = crypto.randomUUID();
    const authorityId = crypto.randomUUID();
    if (options.personal)
      await admin`insert into organization_user_resource_authorities
      (id, account_id, organization_membership_id, resource_kind, resource_id, generation, status)
      values (${authorityId}::uuid, ${org.accountId}::uuid, ${org.membershipId}::uuid,
        'subscription_connection', ${id}::uuid, ${options.generation ?? 1}, 'active')`;
    await admin`insert into subscription_connections(id, account_id, provider, kind, credential_encrypted,
      ownership, scope_kind, allow_personal_workspaces, provider_account_id, provider_subject_id,
      owner_organization_membership_id, owner_subject_id, authority_id, authority_resource_kind, authority_generation,
      allowed_model_ids, label) values
      (${id}::uuid, ${org.accountId}::uuid, ${provider.adapter.provider},
        ${provider.adapter.credentialKind === "api_key" ? "api_key" : "subscription"}, 'fixture-no-secret',
        ${options.personal ? "personal" : "shared"}, ${options.personal ? "people" : "organization"}, true,
        ${id}, ${id}, ${options.personal ? org.membershipId : null}::uuid, ${options.personal ? org.subjectId : null},
        ${options.personal ? authorityId : null}::uuid, ${options.personal ? "subscription_connection" : null},
        ${options.personal ? (options.generation ?? 1) : null},
        ${options.allowedModelIds ? admin.array(options.allowedModelIds) : null}, 'Failover connection')`;
    return id;
  }
  async function claim(workspaceId: string, sessionId: string) {
    const attemptId = crypto.randomUUID();
    const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (result.action !== "claimed") throw new Error(`Claim failed: ${result.reason}`);
    return {
      attemptId,
      executionGeneration: result.turn.executionGeneration,
      holderId: `failover:${sessionId}:${attemptId}`,
      turnId: result.turn.id,
    };
  }
  async function turn(
    org: Awaited<ReturnType<typeof organization>>,
    options: {
      model?: SubscriptionCoreFailoverModel;
      workspaceId?: string;
      ownerless?: boolean;
      private?: boolean;
      sessionId?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ) {
    const model = options.model ?? models[0]!;
    const workspaceId = options.workspaceId ?? org.workspaceId;
    const actor = { subjectId: options.ownerless ? "service:subscription-core" : org.subjectId };
    const sessionId =
      options.sessionId ??
      (
        await withSessionRlsActorContext(actor, () =>
          createSession(client.db, {
            accountId: org.accountId,
            workspaceId,
            initialMessage: "failover",
            resources: [],
            metadata: {},
            model: model.id,
            reasoningEffort: "high",
            latencyMode: "standard",
            sandboxBackend: "none",
            ...(options.private ? { visibility: "user_private" as const } : {}),
            ...(options.ownerless
              ? {}
              : {
                  subjectId: org.subjectId,
                  createdBy: { kind: "subject" as const, subjectId: org.subjectId },
                  createdByContext: {},
                }),
          }),
        )
      ).id;
    const provider = providers.find((value) => value.adapter.provider === model.provider)!;
    await withSessionRlsActorContext(actor, () =>
      enqueueSessionTurn(client.db, {
        accountId: org.accountId,
        workspaceId,
        sessionId,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `session-${sessionId}`,
        source: "user",
        prompt: "failover",
        resources: [],
        tools: [],
        model: model.id,
        reasoningEffort: "high",
        sandboxBackend: "none",
        initiator: options.ownerless
          ? { kind: "service", subjectId: actor.subjectId }
          : { kind: "subject", subjectId: actor.subjectId },
        metadata: {
          turnExecutionPolicyV1: {
            schemaVersion: 1,
            productModelId: model.id,
            requestedModelId: null,
            modelSource: "session",
            reasoningEffort: "high",
            reasoningSource: "session",
            providerId: provider.adapter.modelPolicyProviderId,
            upstreamModelId: model.upstreamModelId,
            wireApi: "chat",
            credentialSource: { kind: "organization_connection", mechanism: "api_key" },
            billing: { upstreamPayer: "organization", metering: "external" },
            definitionVersion: `sha256:${"a".repeat(64)}`,
          },
          ...options.metadata,
        },
      }),
    );
    const attempt = await claim(workspaceId, sessionId);
    const identity = await readSubscriptionCoreTurnIdentity(client.db, {
      accountId: org.accountId,
      workspaceId,
      sessionId,
      turnId: attempt.turnId,
    });
    if (!identity) throw new Error("Missing turn identity");
    return {
      identity,
      ...attempt,
      productModelId: model.id,
      reasoningLevel: "high",
      models,
      leaseTtlMs: 60_000,
      crossProviderFailoverEnabled: true,
    };
  }
  async function exhausted(accountId: string, connectionId: string, resetAt = Date.now() + 60_000) {
    await admin`insert into subscription_connection_quota(account_id, connection_id, quota, observed_refresh_generation, revision, updated_at)
      values (${accountId}::uuid, ${connectionId}::uuid, ${admin.json({
        windows: [],
        modelCooldowns: {},
        exhaustedUntil: resetAt,
        exhaustedKind: "quota",
        source: "refusal",
      })}::jsonb, 1, 1, clock_timestamp())
      on conflict(connection_id) do update set quota = excluded.quota, updated_at = clock_timestamp()`;
  }
  async function binding(work: Awaited<ReturnType<typeof turn>>, provider: string) {
    const [row] = await admin<
      Record<string, unknown>[]
    >`select provider, connection_id::text, model_id, choice,
      only_this_model, last_model_call_at, last_switch_reason, version from subscription_session_bindings
      where workspace_id = ${work.identity.workspaceId}::uuid and session_id = ${work.identity.sessionId}::uuid and provider = ${provider}`;
    return row ?? null;
  }
  async function pin(
    org: Awaited<ReturnType<typeof organization>>,
    work: Awaited<ReturnType<typeof turn>>,
    provider: string,
    connectionId: string | null,
    modelId: string,
    onlyThisModel = false,
    choice: "automatic" | "explicit" = "explicit",
  ) {
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      work.identity.workspaceId,
      org.subjectId,
      async (scoped) => {
        await scoped.execute(
          sql`select set_config('opengeni.initiating_human_subject_id', ${org.subjectId}, true)`,
        );
        const current = await readSubscriptionSessionBinding(scoped, {
          ...work.identity,
          provider,
          forUpdate: true,
        });
        const written = await writeSubscriptionSessionBinding(scoped, {
          ...work.identity,
          provider,
          connectionId,
          modelId,
          onlyThisModel,
          choice,
          expectedVersion: current?.version ?? null,
          lastModelCallAt: new Date(),
          lastSwitchReason: null,
        });
        if (written === null) throw new Error("Pin conflict");
      },
    );
  }
  async function release(work: Awaited<ReturnType<typeof turn>>) {
    const [lease] = await admin<
      { provider: string; connection_id: string; holder_id: string; generation: number }[]
    >`
      select provider, connection_id::text, holder_id, generation from subscription_leases
      where workspace_id = ${work.identity.workspaceId}::uuid and turn_id = ${work.identity.turnId}::uuid`;
    if (lease)
      await withSubscriptionCoreAcceptedTurn(client.db, work.identity, (tx) =>
        releaseSubscriptionTurnLease(tx, {
          ...work.identity,
          provider: lease.provider,
          connectionId: lease.connection_id,
          holderId: lease.holder_id,
          generation: Number(lease.generation),
        }),
      );
  }
  async function finish(work: Awaited<ReturnType<typeof turn>>) {
    await release(work);
    const result = await applySessionTurnSettlement(client.db, work.identity.workspaceId, {
      sessionId: work.identity.sessionId,
      turnId: work.identity.turnId,
      attemptId: work.attemptId,
      triggerEventId: crypto.randomUUID(),
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: {} },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    if (result.action !== "settled") throw new Error("Settlement failed");
  }
  async function recover(work: Awaited<ReturnType<typeof turn>>) {
    await release(work);
    const result = await requestSessionTurnRecovery(client.db, work.identity.workspaceId, {
      sessionId: work.identity.sessionId,
      turnId: work.identity.turnId,
      attemptId: work.attemptId,
      triggerEventId: crypto.randomUUID(),
      reason: "worker_shutdown",
    });
    if (result.action !== "recovering") throw new Error("Recovery failed");
    return { ...work, ...(await claim(work.identity.workspaceId, work.identity.sessionId)) };
  }
  return {
    client,
    admin,
    organization,
    connection,
    turn,
    claim,
    exhausted,
    binding,
    pin,
    release,
    finish,
    recover,
  };
}
