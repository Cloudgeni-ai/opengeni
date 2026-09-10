import { expect } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createHostMcpBinding,
  getHostMcpBinding,
  revokeHostMcpBinding,
  issueHostMcpDelegation,
  getHostMcpDelegation,
  revokeHostMcpDelegation,
  createSession,
  initializeSessionStartAtomically,
  claimSessionWorkForAttempt,
  applySessionTurnSettlement,
  createSessionGoal,
  materializeGoalContinuation,
  withSessionRlsActorContext,
  withDirectHostMcpAdmission,
  captureDirectHostMcpAuthority,
  authorizeDirectHostMcpUse,
  buildHostConnectionTokenResolver,
  nestedPostgresSqlState,
  withWorkspaceSubjectRls,
  withWorkspaceSessionActivityRls,
  type Database,
  type HostMcpBindingOwner,
} from "@opengeni/db";
import { rawRows } from "../../db/src/database";

export async function verifyHostMcpBindings(
  db: Database,
  owner: HostMcpBindingOwner,
  otherSubjectId: string,
) {
  const input = {
    operationId: crypto.randomUUID(),
    definition: {
      serverId: "host-server",
      destinationUrl: "https://mcp.fixture.invalid/tools",
      connectionRef: {
        authoritySource: "host",
        providerDomain: "mcp.fixture.invalid",
        connectionId: "opaque-host-account",
        kind: "oauth2",
        scopes: ["read"],
      },
    },
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => createHostMcpBinding(db, owner, input)),
  );
  const binding = results[0]!;
  expect(new Set(results.map((row) => row.id)).size).toBe(1);
  expect(binding).toMatchObject({
    status: "active",
    generation: 1,
    ownerSubjectId: owner.subjectId,
    authorizationRevision: owner.authorizationRevision,
  });
  expect(await getHostMcpBinding(db, owner, binding.id)).toEqual(binding);
  expect(
    await getHostMcpBinding(db, { ...owner, subjectId: otherSubjectId }, binding.id),
  ).toBeNull();
  const hidden = await withWorkspaceSubjectRls(db, owner.workspaceId, otherSubjectId, (tx) =>
    rawRows(tx, sql`select id from host_mcp_bindings where id = ${binding.id}::uuid`),
  );
  expect(hidden).toEqual([]);
  await expect(
    createHostMcpBinding(db, owner, {
      ...input,
      definition: { ...input.definition, destinationUrl: "https://other.fixture.invalid/tools" },
    }),
  ).rejects.toThrow("operation conflicts");
  const retarget = await withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, (tx) =>
    tx.execute(
      sql`update host_mcp_bindings set definition = '{}'::jsonb where id = ${binding.id}::uuid`,
    ),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(nestedPostgresSqlState(retarget)).toBe("42501");
  const grantInput = {
    operationId: crypto.randomUUID(),
    bindingId: binding.id,
    expectedBindingGeneration: 1,
    grant: { scope: "user", mode: "always", context: "user_private" },
  };
  const grants = await Promise.all(
    Array.from({ length: 8 }, () => issueHostMcpDelegation(db, owner, grantInput)),
  );
  const delegation = grants[0]!;
  expect(new Set(grants.map((row) => row.id)).size).toBe(1);
  expect(delegation).toMatchObject({
    status: "active",
    generation: 1,
    bindingGeneration: 1,
    ownerAuthorizationRevision: owner.authorizationRevision,
  });
  expect(await getHostMcpDelegation(db, owner, delegation.id)).toEqual(delegation);
  expect(
    await getHostMcpDelegation(db, { ...owner, subjectId: otherSubjectId }, delegation.id),
  ).toBeNull();
  expect(
    await withWorkspaceSubjectRls(db, owner.workspaceId, otherSubjectId, (tx) =>
      rawRows(tx, sql`select id from host_mcp_delegations where id = ${delegation.id}::uuid`),
    ),
  ).toEqual([]);
  await expect(
    issueHostMcpDelegation(db, owner, {
      ...grantInput,
      grant: {
        ...grantInput.grant,
        context: "workspace_shared",
        workspaceSharedAcknowledged: true,
      },
    }),
  ).rejects.toThrow("operation conflicts");
  await expect(
    issueHostMcpDelegation(db, owner, {
      ...grantInput,
      operationId: crypto.randomUUID(),
      expectedBindingGeneration: 2,
    }),
  ).rejects.toThrow("operation conflicts");
  await expect(
    issueHostMcpDelegation(db, owner, {
      ...grantInput,
      operationId: crypto.randomUUID(),
      grant: {
        scope: "user",
        mode: "session",
        context: "user_private",
        sessionId: crypto.randomUUID(),
        expectedAuthorityEpoch: 1,
      },
    }),
  ).rejects.toThrow("session authority unavailable");
  const retargetGrant = await withWorkspaceSubjectRls(
    db,
    owner.workspaceId,
    owner.subjectId,
    (tx) =>
      tx.execute(
        sql`update host_mcp_delegations set binding_generation = 2 where id = ${delegation.id}::uuid`,
      ),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(nestedPostgresSqlState(retargetGrant)).toBe("42501");
  const ownerSessionRequest: Parameters<typeof createSession>[1] = {
    accountId: owner.accountId,
    workspaceId: owner.workspaceId,
    subjectId: owner.subjectId,
    createdBy: { kind: "subject", subjectId: owner.subjectId },
    visibility: "user_private",
    initialMessage: "Host session delegation fixture",
    resources: [],
    tools: [{ kind: "mcp", id: binding.definition.serverId }],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createIdempotencyKey: crypto.randomUUID(),
    selectedHostMcpDelegations: [
      { serverId: binding.definition.serverId, delegationId: delegation.id, generation: 1 },
    ],
  };
  const session = await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
    createSession(db, ownerSessionRequest),
  );
  expect(
    (
      await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
        createSession(db, ownerSessionRequest),
      )
    ).id,
  ).toBe(session.id);
  for (const selectedHostMcpDelegations of [
    [],
    [{ serverId: binding.definition.serverId, delegationId: delegation.id, generation: 2 }],
  ]) {
    await expect(
      withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
        createSession(db, { ...ownerSessionRequest, selectedHostMcpDelegations }),
      ),
    ).rejects.toThrow();
  }
  const sessionInput = {
    ...grantInput,
    operationId: crypto.randomUUID(),
    grant: {
      scope: "user",
      mode: "session",
      context: "user_private",
      sessionId: session.id,
      expectedAuthorityEpoch: 1,
    },
  };
  const sessionDelegation = await issueHostMcpDelegation(db, owner, sessionInput);
  expect(sessionDelegation.grant).toMatchObject(sessionInput.grant);
  const rejectedCapture = new Error("reject atomic initial authority fixture");
  await expect(
    withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
      initializeSessionStartAtomically(db, {
        accountId: owner.accountId,
        workspaceId: owner.workspaceId,
        sessionId: session.id,
        reasoningEffortFallback: "medium",
        createdEventPayload: {},
        captureInitialTurnAuthority: async (tx, turnId) => {
          await captureDirectHostMcpAuthority(tx, owner, {
            sessionId: session.id,
            turnId,
            delegationId: sessionDelegation.id,
            expectedDelegationGeneration: 1,
          });
          throw rejectedCapture;
        },
      }),
    ),
  ).rejects.toBe(rejectedCapture);
  const rolledBack = await withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, (tx) =>
    rawRows<{ turns: number; authorities: number; events: number }>(
      tx,
      sql`select (select count(*)::int from session_turns where session_id = ${session.id}::uuid) as turns,
      (select count(*)::int from host_mcp_turn_authorities where session_id = ${session.id}::uuid) as authorities,
      (select count(*)::int from session_events where session_id = ${session.id}::uuid) as events`,
    ),
  );
  expect(rolledBack).toEqual([{ turns: 0, authorities: 0, events: 0 }]);
  await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
    initializeSessionStartAtomically(db, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    }),
  );
  const [turn] = await withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, (tx) =>
    rawRows<{ id: string }>(
      tx,
      sql`select id from session_turns where session_id = ${session.id}::uuid and workspace_id = ${owner.workspaceId}::uuid and status = 'queued' order by created_at limit 1`,
    ),
  );
  expect(turn).toBeDefined();
  const admission = {
    sessionId: session.id,
    turnId: turn!.id,
    delegationId: sessionDelegation.id,
    expectedDelegationGeneration: 1,
  };
  let captures = 0;
  const capture = async (
    _tx: Database,
    authority: import("@opengeni/contracts/host-mcp-bindings").HostMcpAcceptedAuthority,
  ) => {
    captures++;
    return authority;
  };
  const accepted = await withDirectHostMcpAdmission(db, owner, admission, capture);
  expect(accepted).toMatchObject({
    bindingId: binding.id,
    delegationId: sessionDelegation.id,
    ownerSubjectId: owner.subjectId,
    targetSessionId: session.id,
    acceptedWork: { kind: "turn", turnId: turn!.id },
    source: { kind: "direct" },
  });
  expect(accepted.ownerOrganizationMembershipId).toBeString();
  expect(accepted).not.toHaveProperty("apiKeyId");
  const rollbackCapture = new Error("rollback isolated authority capture");
  await withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, async (tx) => {
    expect(await captureDirectHostMcpAuthority(tx, owner, admission)).toEqual(accepted);
    throw rollbackCapture;
  }).catch((error) => {
    if (error !== rollbackCapture) throw error;
  });
  expect(
    await withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, (tx) =>
      rawRows(
        tx,
        sql`select turn_id from host_mcp_turn_authorities where turn_id = ${turn!.id}::uuid`,
      ),
    ),
  ).toEqual([]);
  const storedAuthorities = await Promise.all(
    Array.from({ length: 4 }, () => captureDirectHostMcpAuthority(db, owner, admission)),
  );
  expect(storedAuthorities).toEqual(Array.from({ length: 4 }, () => accepted));
  await expect(
    captureDirectHostMcpAuthority(db, owner, { ...admission, delegationId: delegation.id }),
  ).rejects.toThrow("operation conflicts");
  const readAuthority = (subjectId: string) =>
    withWorkspaceSubjectRls(db, owner.workspaceId, subjectId, (tx) =>
      rawRows<{ canonical_snapshot: unknown }>(
        tx,
        sql`select canonical_snapshot from host_mcp_turn_authorities where turn_id = ${turn!.id}::uuid`,
      ),
    );
  expect(await readAuthority(owner.subjectId)).toEqual([{ canonical_snapshot: accepted }]);
  expect(await readAuthority(otherSubjectId)).toEqual([]);
  for (const query of [
    sql`update host_mcp_turn_authorities set canonical_snapshot = '{}'::jsonb where turn_id = ${turn!.id}::uuid`,
    sql`delete from host_mcp_turn_authorities where turn_id = ${turn!.id}::uuid`,
    sql`insert into host_mcp_turn_authorities (turn_id, server_id, account_id, workspace_id, session_id, owner_subject_id, binding_id, delegation_id, canonical_snapshot)
      select turn_id, server_id, account_id, workspace_id, session_id, owner_subject_id, binding_id, delegation_id,
        jsonb_set(canonical_snapshot, '{bindingGeneration}', '2'::jsonb) from host_mcp_turn_authorities where turn_id = ${turn!.id}::uuid on conflict do nothing`,
    sql`insert into host_mcp_turn_authorities (turn_id, server_id, account_id, workspace_id, session_id, owner_subject_id, binding_id, delegation_id, canonical_snapshot)
      select turn_id, server_id, account_id, workspace_id, session_id, owner_subject_id, binding_id, delegation_id,
        jsonb_set(canonical_snapshot, '{source}', '{"kind":"inherited_turn"}'::jsonb) from host_mcp_turn_authorities where turn_id = ${turn!.id}::uuid on conflict do nothing`,
    sql`insert into host_mcp_turn_authorities (turn_id, server_id, account_id, workspace_id, session_id, owner_subject_id, binding_id, delegation_id, canonical_snapshot)
      values (${turn!.id}::uuid, 'forged-server', ${owner.accountId}::uuid, ${owner.workspaceId}::uuid, ${session.id}::uuid,
        ${owner.subjectId}, ${binding.id}::uuid, ${sessionDelegation.id}::uuid, ${JSON.stringify(accepted)}::jsonb)`,
  ]) {
    const error = await withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, (tx) =>
      tx.execute(query),
    ).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(nestedPostgresSqlState(error)).toBe("42501");
  }
  for (const query of [
    sql`delete from host_mcp_delegations where id = ${sessionDelegation.id}::uuid`,
    sql`delete from host_mcp_bindings where id = ${binding.id}::uuid`,
  ]) {
    const error = await withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, (tx) =>
      tx.execute(query),
    ).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(nestedPostgresSqlState(error)).toBe("23503");
  }
  for (const patch of [
    { expectedDelegationGeneration: 2 },
    { turnId: crypto.randomUUID() },
    { sessionId: crypto.randomUUID() },
  ])
    await expect(
      withDirectHostMcpAdmission(db, owner, { ...admission, ...patch }, capture),
    ).rejects.toThrow("admission unavailable");
  await expect(
    withDirectHostMcpAdmission(db, { ...owner, subjectId: otherSubjectId }, admission, capture),
  ).rejects.toThrow("admission unavailable");
  expect(captures).toBe(1);
  // Roll back this isolated claim so subsequent revocation tests each reach
  // the live grant/binding check, rather than short-circuiting on claimed work.
  const rollbackClaim = new Error("rollback isolated claim fixture");
  await withWorkspaceSessionActivityRls(db, owner.workspaceId, async (tx) => {
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(tx, owner.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    if (claimed.action !== "claimed") throw new Error("Expected claimed host turn");
    const request = {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      sessionId: session.id,
      rootSessionId: session.id,
      turnId: turn!.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      initiator: claimed.turn.initiator,
      initiatorContext: claimed.turn.initiatorContext,
      surface: "model" as const,
      serverId: binding.definition.serverId,
      destinationUrl: binding.definition.destinationUrl,
      credentialTarget: "mcp" as const,
      forceRefresh: false,
      connectionRef: {
        ...binding.definition.connectionRef,
        hostBinding: { bindingId: binding.id, generation: 1 },
      },
    };
    expect(await authorizeDirectHostMcpUse(tx, request)).toBe(true);
    let hostResolutions = 0;
    const resolve = buildHostConnectionTokenResolver(
      async () => {
        hostResolutions++;
        return {
          status: "ok",
          accountId: owner.accountId,
          workspaceId: owner.workspaceId,
          sessionId: session.id,
          providerDomain: request.connectionRef.providerDomain,
          connectionId: request.connectionRef.connectionId!,
          ...(request.connectionRef.scopes ? { scopes: request.connectionRef.scopes } : {}),
          headers: { Authorization: "Bearer synthetic-fixture" },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      {
        ...request,
        authorizeDurableBinding: (candidate) => authorizeDirectHostMcpUse(tx, candidate),
      },
    );
    const credentials = await resolve(request);
    expect(credentials.status).toBe("ok");
    if (credentials.status !== "ok")
      throw new Error("Expected authorized captured host credentials");
    expect(await credentials.authorizeProviderRequest?.()).toBe(true);
    const child = await createSession(tx, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      parentSessionId: session.id,
      visibility: "user_private",
      initialMessage: "No session-grant inheritance",
      resources: [],
      tools: session.tools,
      metadata: {},
      model: session.model,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdByActor: {
        type: "agent_attempt",
        sessionId: session.id,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
      },
    });
    await initializeSessionStartAtomically(tx, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      sessionId: child.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
    expect(
      await withWorkspaceSubjectRls(tx, owner.workspaceId, owner.subjectId, (scoped) =>
        rawRows(
          scoped,
          sql`select turn_id from host_mcp_turn_authorities where session_id = ${child.id}::uuid`,
        ),
      ),
    ).toEqual([]);
    for (const patch of [
      { turnId: crypto.randomUUID() },
      { attemptId: crypto.randomUUID() },
      { executionGeneration: request.executionGeneration + 1 },
      { serverId: "not-accepted" },
      { destinationUrl: "https://wrong.example/mcp" },
      { accountId: crypto.randomUUID() },
    ])
      expect(await authorizeDirectHostMcpUse(tx, { ...request, ...patch })).toBe(false);
    await applySessionTurnSettlement(tx, owner.workspaceId, {
      sessionId: session.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: {} }],
    });
    await createSessionGoal(tx, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      sessionId: session.id,
      text: "Continue the host task",
      createdBy: "api",
    });
    const continuation = await materializeGoalContinuation(tx, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      policy: {
        model: session.model,
        reasoningEffort: "medium",
        latencyMode: "standard",
        tools: session.tools,
        sandboxBackend: "none",
      },
      prompt: () => "Continue with the same accepted host account",
    });
    expect(continuation.action).not.toBe("none");
    const nextAttemptId = crypto.randomUUID();
    const next = await claimSessionWorkForAttempt(tx, owner.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: nextAttemptId,
      trigger: { kind: "next" },
    });
    expect(next.action).toBe("claimed");
    if (next.action !== "claimed") throw new Error("Expected goal continuation claim");
    const inheritedRequest = {
      ...request,
      turnId: next.turn.id,
      attemptId: nextAttemptId,
      executionGeneration: next.turn.executionGeneration,
      initiator: next.turn.initiator,
      initiatorContext: next.turn.initiatorContext,
    };
    expect(await authorizeDirectHostMcpUse(tx, inheritedRequest)).toBe(true);
    const inheritedRows = await withWorkspaceSubjectRls(
      tx,
      owner.workspaceId,
      owner.subjectId,
      (scoped) =>
        rawRows<{ canonical_snapshot: Record<string, unknown> }>(
          scoped,
          sql`select canonical_snapshot from host_mcp_turn_authorities where turn_id = ${next.turn.id}::uuid`,
        ),
    );
    expect(inheritedRows).toHaveLength(1);
    expect(inheritedRows[0]!.canonical_snapshot.source).toEqual({
      kind: "inherited_turn",
      sessionId: session.id,
      turnId: claimed.turn.id,
    });
    await revokeHostMcpDelegation(tx, owner, sessionDelegation.id, 1);
    expect(await authorizeDirectHostMcpUse(tx, inheritedRequest)).toBe(false);
    await applySessionTurnSettlement(tx, owner.workspaceId, {
      sessionId: session.id,
      turnId: next.turn.id,
      triggerEventId: next.turn.triggerEventId,
      attemptId: nextAttemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: {} }],
    });
    await materializeGoalContinuation(tx, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      policy: {
        model: session.model,
        reasoningEffort: "medium",
        latencyMode: "standard",
        tools: session.tools,
        sandboxBackend: "none",
      },
      prompt: () => "Explain the lost host access",
    });
    const revokedAttemptId = crypto.randomUUID();
    const afterRevocation = await claimSessionWorkForAttempt(tx, owner.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: revokedAttemptId,
      trigger: { kind: "next" },
    });
    expect(afterRevocation.action).toBe("claimed");
    if (afterRevocation.action !== "claimed")
      throw new Error("Revocation must not wedge continuation admission");
    expect(
      await authorizeDirectHostMcpUse(tx, {
        ...inheritedRequest,
        turnId: afterRevocation.turn.id,
        attemptId: revokedAttemptId,
        executionGeneration: afterRevocation.turn.executionGeneration,
        initiator: afterRevocation.turn.initiator,
        initiatorContext: afterRevocation.turn.initiatorContext,
      }),
    ).toBe(false);
    expect(
      await withWorkspaceSubjectRls(tx, owner.workspaceId, owner.subjectId, (scoped) =>
        rawRows(
          scoped,
          sql`select turn_id from host_mcp_turn_authorities where turn_id = ${afterRevocation.turn.id}::uuid`,
        ),
      ),
    ).toEqual([]);
    expect(await authorizeDirectHostMcpUse(tx, request)).toBe(false);
    expect(await credentials.authorizeProviderRequest?.()).toBe(false);
    expect(hostResolutions).toBe(1);
    await expect(withDirectHostMcpAdmission(tx, owner, admission, capture)).rejects.toThrow(
      "admission unavailable",
    );
    throw rollbackClaim;
  }).catch((error) => {
    if (error !== rollbackClaim) throw error;
  });
  expect(captures).toBe(1);
  await expect(
    issueHostMcpDelegation(db, owner, {
      ...sessionInput,
      operationId: crypto.randomUUID(),
      grant: { ...sessionInput.grant, expectedAuthorityEpoch: 2 },
    }),
  ).rejects.toThrow("session authority unavailable");
  const revokedGrant = await revokeHostMcpDelegation(db, owner, delegation.id, 1);
  expect(revokedGrant).toMatchObject({ status: "revoked", generation: 2 });
  expect(await revokeHostMcpDelegation(db, owner, delegation.id, 1)).toEqual(revokedGrant);
  expect(await issueHostMcpDelegation(db, owner, grantInput)).toEqual(revokedGrant);
  await expect(
    withDirectHostMcpAdmission(db, owner, { ...admission, delegationId: delegation.id }, capture),
  ).rejects.toThrow("admission unavailable");
  const reviveGrant = await withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, (tx) =>
    tx.execute(
      sql`update host_mcp_delegations set status = 'active', revoked_at = null, generation = 3 where id = ${delegation.id}::uuid`,
    ),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(nestedPostgresSqlState(reviveGrant)).toBe("42501");
  const revoked = await revokeHostMcpBinding(db, owner, binding.id, 1);
  expect(revoked).toMatchObject({ id: binding.id, status: "revoked", generation: 2 });
  expect(revoked.revokedAt).not.toBeNull();
  expect(await revokeHostMcpBinding(db, owner, binding.id, 1)).toEqual(revoked);
  expect(await createHostMcpBinding(db, owner, input)).toEqual(revoked);
  await expect(withDirectHostMcpAdmission(db, owner, admission, capture)).rejects.toThrow(
    "admission unavailable",
  );
  expect(captures).toBe(1);
  expect(await issueHostMcpDelegation(db, owner, grantInput)).toEqual(revokedGrant);
  await expect(
    issueHostMcpDelegation(db, owner, { ...grantInput, operationId: crypto.randomUUID() }),
  ).rejects.toThrow("operation conflicts");
  const resurrect = await withWorkspaceSubjectRls(db, owner.workspaceId, owner.subjectId, (tx) =>
    tx.execute(
      sql`update host_mcp_bindings set status = 'active', revoked_at = null, generation = 3 where id = ${binding.id}::uuid`,
    ),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(nestedPostgresSqlState(resurrect)).toBe("42501");
}
