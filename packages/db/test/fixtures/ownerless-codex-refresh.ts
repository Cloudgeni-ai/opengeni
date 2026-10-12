import { expect } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { SharedTestDatabase } from "@opengeni/testing";
import {
  claimSessionWorkForAttempt,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  loadSubscriptionCoreCodexCredential,
  placeSubscriptionCoreCodexTurn,
  readSubscriptionCoreTurnIdentity,
  withSessionRlsActorContext,
  type DbClient,
} from "../../src";
import { encryptEnvironmentValue } from "../../src/environment-crypto";

// Derived from the independent restricted-role regression that reproduced the
// 0698 refresh gap. Only fixture setup uses admin; runtime calls use opengeni_app.
export type OwnerlessRefreshContext = Pick<SharedTestDatabase, "admin"> & { client: DbClient };
export const ownerlessRefreshKey = Buffer.alloc(32, 73);
export const ownerlessRefreshSettings = {
  environmentsEncryptionKey: ownerlessRefreshKey.toString("base64"),
} as Settings;

export async function ownerlessRefreshFixture(context: OwnerlessRefreshContext, human: boolean) {
  const { admin, client } = context;
  const userId = `ownerless-refresh-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Ownerless refresh regression",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [workspace] = await admin`insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Ownerless refresh regression') returning id::text as id`;
  const workspaceId = workspace!.id as string;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'owner')`;
  await admin`insert into workspace_inference_controls (account_id, workspace_id)
    values (${accountId}::uuid, ${workspaceId}::uuid)`;
  await admin`insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', true)
    on conflict (account_id, provider) do update set enabled = true`;
  await admin`delete from subscription_settings where account_id = ${accountId}::uuid and workspace_id is null`;
  await admin`insert into subscription_settings
    (account_id, rotation, providers, cross_provider_failover, fallback_order,
     personal_connections_allowed, personal_fallback_allowed)
    values (${accountId}::uuid, ${admin.json({ codex: { mode: "spread" } })}::jsonb,
      '{}'::jsonb, false, '{}'::jsonb, true, true)`;
  const encrypted = encryptEnvironmentValue(
    ownerlessRefreshKey,
    JSON.stringify({
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      id_token: "synthetic-id",
    }),
  );
  const [connection] = await admin`insert into subscription_connections
    (account_id, provider, kind, credential_encrypted, ownership, scope_kind,
     provider_account_id, plan_type, expires_at)
    values (${accountId}::uuid, 'codex', 'subscription', ${encrypted}, 'shared', 'organization',
      ${`synthetic-${userId}`}, 'pro', now() - interval '1 minute') returning id::text as id`;
  const connectionId = connection!.id as string;
  await admin`insert into subscription_connection_assignment_policies
    (account_id, connection_id, workspace_id, inference_pool)
    values (${accountId}::uuid, ${connectionId}::uuid, ${workspaceId}::uuid, 'organization')`;
  const session = await createSession(client.db, {
    accountId, workspaceId, initialMessage: "Refresh regression", resources: [], metadata: {},
    model: "codex/gpt-5.5", reasoningEffort: "medium", latencyMode: "standard", sandboxBackend: "none",
  });
  const turn = await withSessionRlsActorContext(
    human ? { subjectId } : { subjectId: "service:subscription-core", initiatingHumanSubjectId: null },
    () => enqueueSessionTurn(client.db, {
      accountId, workspaceId, sessionId: session.id, triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`, source: "user", prompt: "Refresh regression",
      resources: [], tools: [], model: "codex/gpt-5.5", reasoningEffort: "medium", sandboxBackend: "none", metadata: {},
      initiator: human ? { kind: "subject", subjectId } : { kind: "service", subjectId: "service:subscription-core" },
    }),
  );
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id, workflowId: `session-${session.id}`, workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(), attemptId, trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`Fixture claim failed: ${claim.action}`);
  expect(claim.turn.id).toBe(turn.id);
  const identity = await readSubscriptionCoreTurnIdentity(client.db, {
    accountId, workspaceId, sessionId: session.id, turnId: turn.id,
  });
  if (!identity) throw new Error("Accepted identity not readable");
  expect(identity).toMatchObject({
    sessionOwnerSubjectId: null, sessionOwnerMembershipId: null,
    initiatingHumanSubjectId: human ? subjectId : null,
    acceptedAuthorityV2: { version: 2, personal: [] },
  });
  const holderId = `refresh-regression:${attemptId}`;
  expect(await placeSubscriptionCoreCodexTurn(client.db, {
    identity, attemptId, executionGeneration: claim.turn.executionGeneration, holderId,
    productModelId: "codex/gpt-5.5", reasoningLevel: "medium", leaseTtlMs: 120_000,
  })).toMatchObject({ kind: "run", connectionId, personal: false });
  const lease = { connectionId, holderId, generation: claim.turn.executionGeneration };
  expect(await loadSubscriptionCoreCodexCredential(client.db, ownerlessRefreshSettings, identity, lease))
    .toMatchObject({ kind: "loaded" });
  return { identity, lease, subjectId, accountId, workspaceId, connectionId, attemptId };
}
