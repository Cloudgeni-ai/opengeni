import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import {
  bootstrapWorkspace,
  createDb,
  createLensAppRegistration,
  createLensRepositoryBinding,
  createSession,
  LensDeliveryConflictError,
  LensDispatchAuthorityError,
  recordLensWebhookDelivery,
  resolveLensGitCredential,
  updateLensRepositoryBinding,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("opengeni-lens");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but the PostgreSQL harness is unavailable");
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(label: string) {
  if (!client || !shared) throw new Error("database unavailable");
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni-lens-test",
    accountExternalId: `account-${label}-${suffix}`,
    accountName: `Lens ${label}`,
    workspaceExternalSource: "opengeni-lens-test",
    workspaceExternalId: `workspace-${label}-${suffix}`,
    workspaceName: `Lens ${label}`,
    subjectId: `subject-${label}-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`
    insert into pack_installations (
      account_id, workspace_id, pack_id, status, installed_by_subject_id, metadata
    ) values (
      ${grant.accountId}, ${grant.workspaceId}, 'opengeni-lens', 'active',
      ${grant.subjectId}, '{}'::jsonb
    )`;
  const registration = await createLensAppRegistration(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    name: "Lens GitHub App",
    provider: "github",
    providerBaseUrl: "https://github.com",
    appId: "12345",
    credentialKind: "github_app",
    credentialEncrypted: "encrypted-private-key",
    accessTokenExpiresAt: null,
    webhookAuthKind: "hmac_sha256",
    webhookSecretEncrypted: "encrypted-webhook-secret",
    webhookUsername: null,
    createdBySubjectId: grant.subjectId,
  });
  const binding = await createLensRepositoryBinding(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    registrationId: registration.id,
    provider: "github",
    repositoryUri: "https://github.com/example/repository.git",
    repositoryFullName: "example/repository",
    providerRepositoryId: "991",
    installationId: "881",
    projectId: null,
    model: null,
    additionalInstructions: null,
    status: "active",
    createdBySubjectId: grant.subjectId,
  });
  return { grant, registration, binding };
}

async function lensAttemptAuthority(value: Awaited<ReturnType<typeof fixture>>) {
  if (!client || !shared) throw new Error("database unavailable");
  const headSha = "e".repeat(40);
  const recorded = await recordLensWebhookDelivery(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    registrationId: value.registration.id,
    repositoryBindingId: value.binding.id,
    provider: "github",
    deliveryKey: `credential-${crypto.randomUUID()}`,
    requestDigest: "f".repeat(64),
    eventName: "pull_request",
    action: "synchronize",
    pullRequestId: "17",
    headSha,
    baseSha: "d".repeat(40),
  });
  const session = await createSession(client.db, {
    requestedSessionId: recorded.delivery.id,
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    initialMessage: "Review pull request 17",
    resources: [],
    metadata: {
      role: "pull_request_review",
      lensRegistrationId: value.registration.id,
      lensRepositoryBindingId: value.binding.id,
      lensProviderRepositoryId: value.binding.providerRepositoryId,
      lensHeadSha: headSha,
      lensDeliveryId: recorded.delivery.id,
    },
    createdBy: { kind: "service", subjectId: "opengeni-lens" },
    createdByContext: { deliveryId: recorded.delivery.id },
    policyRole: "pull_request_review",
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const workflowId = `lens-${session.id}`;
  await shared.admin.begin(async (sql) => {
    await sql`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, source, position, prompt, model,
        reasoning_effort, sandbox_backend, execution_generation,
        active_attempt_id, initiator_kind, initiator_subject_id, initiator_context
      ) values (
        ${turnId}, ${value.grant.accountId}, ${value.grant.workspaceId}, ${session.id},
        ${crypto.randomUUID()}, ${workflowId}, 'running', 'user', 1,
        'Review pull request 17', 'scripted-model', 'medium', 'none', 1,
        ${attemptId}, 'service', 'opengeni-lens',
        ${JSON.stringify({ deliveryId: recorded.delivery.id })}::jsonb
      )`;
    await sql`
      update sessions
      set status = 'running', active_turn_id = ${turnId}, temporal_workflow_id = ${workflowId}
      where id = ${session.id}`;
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id,
        execution_generation, state, temporal_workflow_id,
        temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${value.grant.accountId}, ${value.grant.workspaceId}, ${session.id}, ${turnId},
        1, 'running', ${workflowId}, ${`run-${attemptId}`}, ${`activity-${attemptId}`},
        0, '{}'::jsonb
      )`;
  });
  return {
    sessionId: session.id,
    rootSessionId: session.id,
    turnId,
    attemptId,
    executionGeneration: 1,
    expectedCommitSha: headSha,
  };
}

describe("OpenGeni Lens durable authority", () => {
  test("resolves only an active exact repository authority", async () => {
    if (!client || !shared) return;
    const lens = await fixture("credential");
    const { grant, registration, binding } = lens;
    const authority = await lensAttemptAuthority(lens);
    await expect(
      resolveLensGitCredential(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        registrationId: registration.id,
        provider: "github",
        sessionId: crypto.randomUUID(),
        rootSessionId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        executionGeneration: 1,
        repositoryRefs: [
          {
            uri: binding.repositoryUri,
            expectedCommitSha: authority.expectedCommitSha,
            repositoryId: binding.providerRepositoryId,
            installationId: binding.installationId!,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(LensDispatchAuthorityError);

    await expect(
      resolveLensGitCredential(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        registrationId: registration.id,
        provider: "github",
        ...authority,
        repositoryRefs: [
          {
            uri: binding.repositoryUri,
            expectedCommitSha: authority.expectedCommitSha,
            repositoryId: binding.providerRepositoryId,
            installationId: binding.installationId!,
          },
        ],
      }),
    ).resolves.toMatchObject({
      credentialKind: "github_app",
      appId: "12345",
      credentialEncrypted: "encrypted-private-key",
    });

    await expect(
      resolveLensGitCredential(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        registrationId: registration.id,
        provider: "github",
        ...authority,
        repositoryRefs: [
          {
            uri: binding.repositoryUri,
            expectedCommitSha: authority.expectedCommitSha,
            repositoryId: binding.providerRepositoryId,
            installationId: "different-installation",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(LensDispatchAuthorityError);

    await updateLensRepositoryBinding(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      bindingId: binding.id,
      status: "disabled",
    });
    await expect(
      resolveLensGitCredential(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        registrationId: registration.id,
        provider: "github",
        ...authority,
        repositoryRefs: [
          {
            uri: binding.repositoryUri,
            expectedCommitSha: authority.expectedCommitSha,
            repositoryId: binding.providerRepositoryId,
            installationId: binding.installationId!,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(LensDispatchAuthorityError);
  });

  test("linearizes concurrent delivery replays and rejects changed bytes", async () => {
    if (!client || !shared) return;
    const { grant, registration, binding } = await fixture("delivery");
    const input = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      registrationId: registration.id,
      repositoryBindingId: binding.id,
      provider: "github" as const,
      deliveryKey: `delivery-${crypto.randomUUID()}`,
      requestDigest: "a".repeat(64),
      eventName: "pull_request",
      action: "synchronize",
      pullRequestId: "17",
      headSha: "b".repeat(40),
      baseSha: "c".repeat(40),
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => await recordLensWebhookDelivery(client!.db, input)),
    );
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(new Set(results.map((result) => result.delivery.id)).size).toBe(1);

    await expect(
      recordLensWebhookDelivery(client.db, {
        ...input,
        requestDigest: "d".repeat(64),
      }),
    ).rejects.toBeInstanceOf(LensDeliveryConflictError);
  });
});
