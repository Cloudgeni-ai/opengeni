import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import {
  beginRigVersionVerificationAttempt,
  createRig as createInactiveRig,
  bootstrapWorkspace,
  createDb,
  createRigChange,
  createRigVersion,
  createSession,
  getRigChange,
  listPendingInactiveRigVersionVerificationAttempts,
  updateRigChangeStatus,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  createVerifiedTestRig as createRig,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let accountId = "";
let workspaceId = "";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_rigs_mcp");
  if (!shared) {
    available = false;
    console.warn("[rigs-mcp] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:test",
    accountExternalId: `rigs-mcp-${crypto.randomUUID()}`,
    accountName: "Rigs MCP",
    workspaceExternalSource: "opengeni:test",
    workspaceExternalId: `rigs-mcp-${crypto.randomUUID()}`,
    workspaceName: "Rigs MCP",
    subjectId: "user:mcp",
  });
  accountId = access.defaultAccountId!;
  workspaceId = access.defaultWorkspaceId!;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function rigVersionState(versionId: string): Promise<{
  active: boolean;
  verification: Record<string, unknown>;
}> {
  const [row] = await shared!.admin<
    Array<{ active: boolean; verification: Record<string, unknown> }>
  >`
    select active, verification from rig_versions where id = ${versionId}
  `;
  if (!row) throw new Error(`Rig version not found: ${versionId}`);
  return row;
}

describe("rig MCP tools", () => {
  test("a worker-signed attempt resolves personal rigs through its frozen initiating human", async () => {
    if (!available) return;
    const subjectId = `human:${crypto.randomUUID()}`;
    const [personalWorkspace] = await shared!.admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${accountId}, 'MCP personal workspace') returning id
    `;
    const [targetWorkspace] = await shared!.admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name)
      values (${accountId}, 'MCP target workspace') returning id
    `;
    await shared!.admin`
      insert into workspace_inference_controls (workspace_id, account_id) values
        (${personalWorkspace!.id}, ${accountId}), (${targetWorkspace!.id}, ${accountId})
    `;
    await shared!.admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id, authorization_revision
      ) values (${accountId}, ${subjectId}, 'active', ${personalWorkspace!.id}, 1)
    `;
    await shared!.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id) values
        (${accountId}, ${workspaceId}, ${subjectId}),
        (${accountId}, ${targetWorkspace!.id}, ${subjectId})
    `;
    const personalRig = await createRig(client.db, {
      accountId,
      workspaceId,
      scope: "user",
      subjectId,
      name: `personal-mcp-${crypto.randomUUID()}`,
      createdBy: subjectId,
      initialVersion: { setupScript: "true", changelog: "personal" },
    });
    const session = await createSession(client.db, {
      accountId,
      workspaceId: targetWorkspace!.id,
      initialMessage: "list my personal rigs",
      resources: [],
      tools: [],
      metadata: {},
      model: "gpt-test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId },
      subjectId,
      firstPartyMcpPermissions: ["rigs:use"],
      firstPartyMcpTools: ["rig_list"],
    });
    const [sessionAuthority] = await shared!.admin<
      Array<{
        authorityEpoch: number;
        visibility: "user_private" | "workspace_shared";
        ownerOrganizationMembershipId: string | null;
      }>
    >`
      select authority_epoch as "authorityEpoch", visibility,
        owner_organization_membership_id as "ownerOrganizationMembershipId"
      from sessions where id = ${session.id}
    `;
    const executionGeneration = 1;
    const [turn] = await shared!.admin<Array<{ id: string }>>`
      insert into session_turns (
        account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, position, prompt, model, reasoning_effort, sandbox_backend,
        execution_generation, initiator_kind, initiator_subject_id,
        initiating_human_subject_id, initiator_context
      ) values (
        ${accountId}, ${targetWorkspace!.id}, ${session.id}, gen_random_uuid(),
        ${`rig-mcp-${crypto.randomUUID()}`}, 'running', 0, 'list personal rigs',
        'gpt-test', 'medium', 'none', ${executionGeneration}, 'subject', ${subjectId},
        ${subjectId}, '{"accepted":true}'::jsonb
      ) returning id
    `;
    const attemptId = crypto.randomUUID();
    await shared!.admin.begin(async (tx) => {
      await tx.unsafe("set local opengeni.session_inference_claim = '1'");
      await tx`
        update sessions set active_turn_id = ${turn!.id}, status = 'running'
        where id = ${session.id}
      `;
      await tx`
        update session_turns set active_attempt_id = ${attemptId}, status = 'running'
        where id = ${turn!.id}
      `;
      await tx`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
          verified_control_revision, authority_epoch, authority_visibility,
          authority_owner_organization_membership_id, mcp_approval_policies,
          connector_action_policies
        ) values (
          ${attemptId}, ${accountId}, ${targetWorkspace!.id}, ${session.id}, ${turn!.id},
          ${executionGeneration}, 'running', 'rig-mcp', ${`run-${attemptId}`},
          ${`activity-${attemptId}`}, 0, ${sessionAuthority!.authorityEpoch},
          ${sessionAuthority!.visibility}, ${sessionAuthority!.ownerOrganizationMembershipId},
          '{}'::jsonb, '[]'::jsonb
        )
      `;
    });
    const agentGrant: AccessGrant = {
      accountId,
      workspaceId: targetWorkspace!.id,
      subjectId: "worker:first-party-mcp",
      principalKind: "agent_attempt",
      permissions: ["rigs:use"],
      metadata: {
        sessionId: session.id,
        turnId: turn!.id,
        attemptId,
        executionGeneration,
        firstPartyMcpTools: ["rig_list"],
      },
    };
    const server = buildOpenGeniMcpServer(deps(new FakeWorkflowClient()), agentGrant);
    const listed = await callMcpTool<{ rigs: Array<{ id: string }> }>(server, "rig_list", {});
    expect(listed.rigs.map((rig) => rig.id)).toContain(personalRig.id);
  }, 60_000);

  test("rig_list and rig_get are available under rigs:use", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-list-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: { setupScript: "true", changelog: "v1" },
    });
    const server = buildOpenGeniMcpServer(deps(workflow), grant(["rigs:use"]));
    const tools = toolNames(server);
    expect(tools).toContain("rig_list");
    expect(tools).toContain("rig_get");

    const listed = await callMcpTool<{ rigs: Array<{ id: string }> }>(server, "rig_list", {});
    expect(listed.rigs.some((candidate) => candidate.id === rig.id)).toBe(true);
    const got = await callMcpTool<{
      rig: { id: string };
      versions: unknown[];
      changes: unknown[];
    }>(server, "rig_get", { rigId: rig.id });
    expect(got.rig.id).toBe(rig.id);
    expect(got.versions.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(got.changes)).toBe(true);

    const clamped = await callMcpTool<{
      versions: unknown[];
      changes: unknown[];
    }>(server, "rig_get", {
      rigId: rig.id,
      versionLimit: 1_000,
      changeLimit: 1_000,
    });
    expect(clamped.versions).toHaveLength(1);
    expect(clamped.changes).toHaveLength(0);
  });

  test("rig_verify dispatches an active version with one durable attempt identity", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-verify-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: { setupScript: "true" },
    });
    const server = buildOpenGeniMcpServer(deps(workflow), grant(["rigs:use"]));
    const receipt = await callMcpTool<{
      facts: { verificationAttempt: string };
      resource: { id: string; state: string };
    }>(server, "rig_verify", { rigId: rig.id });
    const attemptId = receipt.facts.verificationAttempt;
    expect(receipt.resource).toMatchObject({
      id: rig.activeVersion!.id,
      state: "verification_started",
    });
    expect(workflow.rigVerifications).toEqual([
      {
        workspaceId,
        versionId: rig.activeVersion!.id,
        attemptId,
        workflowId: `rig-verification-version-${rig.activeVersion!.id}-attempt-${attemptId}`,
      },
    ]);
  });

  test("rig_verify reports active dispatch uncertainty without replacing the pending attempt", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    workflow.failRigVerification = true;
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-active-dispatch-outage-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: { setupScript: "true" },
    });
    const activeVersion = rig.activeVersion!;
    const server = buildOpenGeniMcpServer(deps(workflow), grant(["rigs:use"]));

    const first = await callMcpTool<{
      committed: boolean;
      outcome: string;
      changed: boolean;
      resource: { id: string; state: string };
      idempotency: { status: string };
      partialFailure: { stage: string; retryable: boolean };
      facts: { verificationAttempt: string; expectedActiveVersionId: string };
      nextAction: { tool: string; arguments: { rigId: string } };
    }>(server, "rig_verify", { rigId: rig.id });
    expect(first).toMatchObject({
      committed: true,
      outcome: "partial_failure",
      changed: true,
      resource: { id: activeVersion.id, state: "verification_pending" },
      idempotency: { status: "unknown" },
      partialFailure: { stage: "verification_workflow_start", retryable: true },
      facts: {
        expectedActiveVersionId: activeVersion.id,
      },
      nextAction: { tool: "rig_verify", arguments: { rigId: rig.id } },
    });
    const stateAfterFirst = await rigVersionState(activeVersion.id);
    expect(stateAfterFirst).toMatchObject({
      active: true,
      verification: {
        status: "pending",
        attemptId: first.facts.verificationAttempt,
      },
    });

    const second = await callMcpTool<typeof first>(server, "rig_verify", { rigId: rig.id });
    expect(second).toMatchObject({
      committed: true,
      outcome: "partial_failure",
      changed: false,
      resource: { id: activeVersion.id, state: "verification_pending" },
      idempotency: { status: "unknown" },
      partialFailure: { stage: "verification_workflow_start", retryable: true },
      facts: { verificationAttempt: first.facts.verificationAttempt },
      nextAction: { tool: "rig_verify", arguments: { rigId: rig.id } },
    });
    expect(await rigVersionState(activeVersion.id)).toEqual(stateAfterFirst);
    expect(workflow.rigVerifications).toHaveLength(2);
    expect(workflow.rigVerifications[1]).toEqual(workflow.rigVerifications[0]);
  });

  test("rig_verify reports an outcome-unknown retry as unchanged after dispatch succeeds", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    workflow.failRigVerification = true;
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-active-dispatch-recovery-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: { setupScript: "true" },
    });
    const activeVersion = rig.activeVersion!;
    const server = buildOpenGeniMcpServer(deps(workflow), grant(["rigs:use"]));

    const first = await callMcpTool<{
      outcome: string;
      changed: boolean;
      idempotency: { status: string };
      facts: { verificationAttempt: string };
    }>(server, "rig_verify", { rigId: rig.id });
    expect(first).toMatchObject({
      outcome: "partial_failure",
      changed: true,
      idempotency: { status: "unknown" },
    });
    const stateAfterFirst = await rigVersionState(activeVersion.id);

    workflow.failRigVerification = false;
    // The production workflow client also normalizes Temporal AlreadyStarted
    // into this successful return path for the same deterministic workflow id.
    const recovered = await callMcpTool<typeof first>(server, "rig_verify", { rigId: rig.id });
    expect(recovered).toMatchObject({
      outcome: "accepted",
      changed: false,
      resource: { id: activeVersion.id, state: "verification_started" },
      idempotency: { status: "not_supported" },
      facts: { verificationAttempt: first.facts.verificationAttempt },
    });
    expect(await rigVersionState(activeVersion.id)).toEqual(stateAfterFirst);
    expect(workflow.rigVerifications).toHaveLength(2);
    expect(workflow.rigVerifications[1]).toEqual(workflow.rigVerifications[0]);
  });

  test("rig_verify recovers only the unique inactive pending attempt without superseding it", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-recover-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: { setupScript: "true" },
    });
    const candidate = await createRigVersion(client.db, workspaceId, rig.id, {
      setupScript: "echo candidate",
    });
    const attempt = await beginRigVersionVerificationAttempt(client.db, {
      workspaceId,
      rigId: rig.id,
      versionId: candidate.id,
    });
    const server = buildOpenGeniMcpServer(deps(workflow), grant(["rigs:use"]));

    workflow.failRigVerification = true;
    const deferred = await callMcpTool<{
      outcome: string;
      changed: boolean;
      partialFailure: { retryable: boolean };
      facts: { verificationAttempt: string; expectedActiveVersionId: string };
    }>(server, "rig_verify", { rigId: rig.id, recoverDeferredVersion: true });
    expect(deferred).toMatchObject({
      outcome: "partial_failure",
      changed: false,
      resource: { id: candidate.id, state: "verification_pending" },
      partialFailure: { retryable: true },
      facts: {
        verificationAttempt: attempt.attemptId,
        expectedActiveVersionId: rig.activeVersion!.id,
      },
    });
    expect(
      await listPendingInactiveRigVersionVerificationAttempts(client.db, workspaceId, rig.id),
    ).toEqual([
      {
        versionId: candidate.id,
        version: candidate.version,
        attemptId: attempt.attemptId,
        expectedActiveVersionId: rig.activeVersion!.id,
        requestedAt: attempt.requestedAt,
      },
    ]);

    workflow.failRigVerification = false;
    const recovered = await callMcpTool<{
      outcome: string;
      changed: boolean;
      facts: { verificationAttempt: string };
    }>(server, "rig_verify", { rigId: rig.id, recoverDeferredVersion: true });
    expect(recovered).toMatchObject({
      outcome: "accepted",
      changed: false,
      resource: { id: candidate.id, state: "verification_pending" },
      facts: { verificationAttempt: attempt.attemptId },
    });
    expect(workflow.rigVerifications).toHaveLength(2);
    expect(workflow.rigVerifications).toEqual([
      {
        workspaceId,
        versionId: candidate.id,
        attemptId: attempt.attemptId,
        workflowId: `rig-verification-version-${candidate.id}-attempt-${attempt.attemptId}`,
      },
      {
        workspaceId,
        versionId: candidate.id,
        attemptId: attempt.attemptId,
        workflowId: `rig-verification-version-${candidate.id}-attempt-${attempt.attemptId}`,
      },
    ]);
  });

  test("rig_verify deferred recovery refuses zero and ambiguous candidates", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-recover-ambiguous-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: { setupScript: "true" },
    });
    const server = buildOpenGeniMcpServer(deps(workflow), grant(["rigs:use"]));
    await expect(
      callMcpTool(server, "rig_verify", { rigId: rig.id, recoverDeferredVersion: true }),
    ).rejects.toThrow(/no inactive pending verification attempt/iu);

    const first = await createRigVersion(client.db, workspaceId, rig.id, {
      setupScript: "echo first",
    });
    const second = await createRigVersion(client.db, workspaceId, rig.id, {
      setupScript: "echo second",
    });
    await beginRigVersionVerificationAttempt(client.db, {
      workspaceId,
      rigId: rig.id,
      versionId: first.id,
    });
    await beginRigVersionVerificationAttempt(client.db, {
      workspaceId,
      rigId: rig.id,
      versionId: second.id,
    });
    await expect(
      callMcpTool(server, "rig_verify", { rigId: rig.id, recoverDeferredVersion: true }),
    ).rejects.toThrow(/more than one inactive Rig version/iu);
    expect(workflow.rigVerifications).toEqual([]);
  });

  test("rig_propose_change creates a setup_append change and triggers verification", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    const sessionId = crypto.randomUUID();
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-propose-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: { setupScript: "mkdir -p /opt/mcp", changelog: "v1" },
    });
    const server = buildOpenGeniMcpServer(
      deps(workflow),
      grant(["rigs:use"], {
        sessionId,
        firstPartyMcpTools: ["rig_propose_change"],
      }),
    );
    const proposed = await callMcpTool<{
      resource: { id: string; state: string };
      facts: { verificationStarted: boolean; verificationAttempt: string };
    }>(server, "rig_propose_change", {
      rigId: rig.id,
      command: "touch /opt/mcp/tool",
      note: "mcp proposal",
    });
    expect(proposed).toMatchObject({
      operation: "rig_propose_change",
      outcome: "created",
      resource: { type: "rig_change", state: "verifying" },
      facts: { verificationStarted: true },
    });
    expect(proposed.facts.verificationAttempt).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(proposed)).not.toContain("touch /opt/mcp/tool");
    expect(JSON.stringify(proposed)).not.toContain("mcp proposal");
    expect(workflow.rigVerifications).toEqual([
      {
        workspaceId,
        changeId: proposed.resource.id,
        attemptId: proposed.facts.verificationAttempt,
        workflowId: `rig-verification-change-${proposed.resource.id}-attempt-${proposed.facts.verificationAttempt}`,
      },
    ]);
    const stored = await getRigChange(client.db, workspaceId, proposed.resource.id);
    expect(stored?.kind).toBe("setup_append");
    expect(stored?.proposedBy).toBe(`session:${sessionId}`);
  });

  test("rig_create_version recovers a Rig with no active version using an explicit null CAS", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    const rig = await createInactiveRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-replacement-${crypto.randomUUID()}`,
      activateInitialVersion: false,
    });
    const server = buildOpenGeniMcpServer(deps(workflow), grant(["rigs:use", "rigs:manage"]));

    await expect(
      callMcpTool(server, "rig_create_version", {
        rigId: rig.id,
        setupScript: null,
        checks: [],
        credentialHooks: [],
        defaultVariableSetIds: [],
      }),
    ).rejects.toThrow(/expectedActiveVersionId: null/iu);

    const created = await callMcpTool<{
      outcome: string;
      resource: { id: string; state: string };
      facts: { verificationAttempt: string };
    }>(server, "rig_create_version", {
      rigId: rig.id,
      expectedActiveVersionId: null,
      setupScript: null,
      checks: [],
      credentialHooks: [],
      defaultVariableSetIds: [],
    });
    expect(created).toMatchObject({
      outcome: "created",
      resource: { state: "verification_pending" },
    });
    expect(created.facts.verificationAttempt).toMatch(/^[0-9a-f-]{36}$/u);
    expect(workflow.rigVerifications).toContainEqual({
      workspaceId,
      versionId: created.resource.id,
      attemptId: created.facts.verificationAttempt,
      workflowId: `rig-verification-version-${created.resource.id}-attempt-${created.facts.verificationAttempt}`,
    });
  });

  test("rig_get keeps one bounded active definition and summary-only history", async () => {
    if (!available) return;
    const huge = "界🙂".repeat(75_000);
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-bounded-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: {
        setupScript: `echo active-start\n${huge}\necho active-end`,
        checks: Array.from({ length: 40 }, (_, index) => ({
          name: `check-${index}`,
          command: `${huge}-${index}`,
        })),
        credentialHooks: Array.from({ length: 100 }, (_, index) => `${huge}-${index}`),
        changelog: huge,
      },
    });
    for (let version = 2; version <= 7; version += 1) {
      await createRigVersion(client.db, workspaceId, rig.id, {
        setupScript: `echo version-${version}\n${huge}`,
        checks: Array.from({ length: version }, (_, index) => ({
          name: `v${version}-check-${index}`,
          command: huge,
        })),
        changelog: `${huge}-${version}`,
      });
    }
    for (let index = 0; index < 7; index += 1) {
      const change = await createRigChange(client.db, {
        accountId,
        workspaceId,
        rigId: rig.id,
        baseVersionId: rig.activeVersion!.id,
        kind: "setup_append",
        payload: {
          command: `echo change-${index}\n${huge}`,
          nested: { exactPayloadMustNotReachModelHistory: huge },
        },
        proposedBy: `session:${crypto.randomUUID()}`,
      });
      await updateRigChangeStatus(client.db, workspaceId, change.id, {
        status: "verifying",
        verification: {
          attempt: index + 1,
          startedAt: `2026-07-19T00:00:0${index}.000Z`,
          finishedAt: `2026-07-19T00:01:0${index}.000Z`,
          passed: index % 2 === 0,
          log: `verification-${index}-${huge}`,
        },
      });
    }

    const server = buildOpenGeniMcpServer(deps(new FakeWorkflowClient()), grant(["rigs:use"]));
    const got = await callMcpTool<{
      rig: {
        activeVersion: { setupScript: string; checks: unknown };
        versionCount: number;
      };
      versions: Array<Record<string, unknown>>;
      versionsTotal: number;
      versionsTruncated: boolean;
      changes: Array<Record<string, unknown>>;
      changesTotal: number;
      changesTruncated: boolean;
      projection: {
        bytes: number;
        maxBytes: number;
        truncated: boolean;
        fields: Record<string, { originalBytes: number | null; truncated: boolean }>;
      };
    }>(server, "rig_get", { rigId: rig.id, versionLimit: 3, changeLimit: 5 });
    expect(got.projection.bytes).toBe(Buffer.byteLength(JSON.stringify(got, null, 2), "utf8"));
    expect(got.projection.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(got.projection.maxBytes).toBe(64 * 1024);
    expect(got.projection.truncated).toBeTrue();
    expect(got.rig.versionCount).toBe(7);
    expect(got.rig.activeVersion.setupScript).toContain("model monitoring projection");
    expect(got.versionsTotal).toBe(7);
    expect(got.versionsTruncated).toBeTrue();
    expect(got.versions).toHaveLength(3);
    expect(got.versions[0]).toMatchObject({
      setupScriptBytes: expect.any(Number),
      checkCount: expect.any(Number),
    });
    expect(got.versions[0]).not.toHaveProperty("setupScript");
    expect(got.versions[0]).not.toHaveProperty("checks");
    expect(got.changesTotal).toBe(7);
    expect(got.changesTruncated).toBeTrue();
    expect(got.changes).toHaveLength(5);
    expect(got.changes[0]).toMatchObject({
      payloadBytes: expect.any(Number),
      verificationBytes: expect.any(Number),
      verificationLogBytes: expect.any(Number),
      verificationPassed: expect.any(Boolean),
    });
    expect(got.changes[0]).not.toHaveProperty("payload");
    expect(got.changes[0]).not.toHaveProperty("verification");
    expect(JSON.stringify(got)).not.toContain("exactPayloadMustNotReachModelHistory");
    expect(got.projection.fields.activeSetupScript.originalBytes).toBeGreaterThan(100_000);
  });

  test("rig_promote is absent without rigs:manage", async () => {
    if (!available) return;
    const server = buildOpenGeniMcpServer(deps(new FakeWorkflowClient()), grant(["rigs:use"]));
    expect(toolNames(server)).not.toContain("rig_promote");
    await expect(
      callMcpTool(server, "rig_promote", {
        rigId: crypto.randomUUID(),
        changeId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("MCP tool not registered");
  });
});

function deps(workflowClient: SessionWorkflowClient): ApiRouteDeps {
  return {
    settings: testSettings({}),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient,
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as never;
}

function grant(permissions: Permission[], metadata: Record<string, unknown> = {}): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "user:mcp",
    permissions,
    metadata,
  };
}

function toolNames(server: unknown): string[] {
  return Object.keys(
    (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
  ).sort();
}

async function callMcpTool<T = unknown>(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        {
          handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
        }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) {
    throw new Error(`MCP tool not registered: ${name}`);
  }
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) {
    throw new Error(`MCP tool returned no text: ${name}`);
  }
  return JSON.parse(text) as T;
}

class FakeWorkflowClient implements SessionWorkflowClient {
  rigVerifications: unknown[] = [];
  failRigVerification = false;
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
  async startRigVerification(input: unknown): Promise<void> {
    this.rigVerifications.push(input);
    if (this.failRigVerification) throw new Error("temporal unavailable");
  }
}
