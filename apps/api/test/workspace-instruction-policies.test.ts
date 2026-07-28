import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  getWorkspaceInstructionPolicyRevision,
  getWorkspace,
  updateWorkspace,
  withRlsContext,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import * as dbSchema from "@opengeni/db/schema";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import { registerWorkspaceInstructionPolicyRoutes } from "../src/routes/workspace-instruction-policies";

const SECRET = "workspace-instruction-policy-test-secret-at-least-32-bytes";

type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let legacyGrant: Grant;
let defaultGrant: Grant;

beforeAll(async () => {
  const explicitAdminUrl = process.env.OPENGENI_WORKSPACE_INSTRUCTION_POLICY_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_WORKSPACE_INSTRUCTION_POLICY_TEST_APP_URL;
  if (explicitAdminUrl && explicitAppUrl) {
    const explicitAppPassword = decodeURIComponent(new URL(explicitAppUrl).password);
    await migrate(explicitAdminUrl);
    await provisionRoles(explicitAdminUrl, { appPassword: explicitAppPassword });
    const admin = postgres(explicitAdminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl: explicitAdminUrl,
      appUrl: explicitAppUrl,
      release: async () => {
        await admin.end();
      },
    };
  } else {
    const acquired = await acquireSharedTestDatabase("workspace-instruction-policies");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
  }
  client = createDb(shared.appUrl);
  const legacyAccess = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `instruction-policy-account-${crypto.randomUUID()}`,
    accountName: "Instruction policy account",
    workspaceExternalSource: "test",
    workspaceExternalId: `instruction-policy-workspace-${crypto.randomUUID()}`,
    workspaceName: "Instruction policy workspace",
    subjectId: "user:policy-admin",
  });
  legacyGrant = legacyAccess.workspaceGrants[0]!;
  await updateWorkspace(client.db, legacyGrant.workspaceId, {
    agentInstructions: "LEGACY WORKSPACE PERSONA {{core}}",
  });

  const defaultAccess = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `instruction-policy-default-account-${crypto.randomUUID()}`,
    accountName: "Default behavior account",
    workspaceExternalSource: "test",
    workspaceExternalId: `instruction-policy-default-workspace-${crypto.randomUUID()}`,
    workspaceName: "Default behavior workspace",
    subjectId: "user:policy-admin",
  });
  defaultGrant = defaultAccess.workspaceGrants[0]!;

  app = new Hono();
  registerWorkspaceInstructionPolicyRoutes(app, {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
    db: client.db,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function bearerFor(grant: Grant, permissions: Permission[]): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function request(
  grant: Grant,
  path: string,
  options: { method?: string; body?: unknown; permissions?: Permission[] } = {},
): Promise<Response> {
  const bearer = await bearerFor(
    grant,
    options.permissions ?? ["workspace:read", "workspace:admin"],
  );
  const headers: Record<string, string> = {};
  headers.authorization = bearer;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return await app.request(`http://x/v1/workspaces/${grant.workspaceId}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function createDraft(
  grant: Grant,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await request(grant, "/instruction-policies/drafts", {
    method: "POST",
    body,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Record<string, any>;
}

function errorChainMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current) && messages.length < 16) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

async function expectDatabaseFailure(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  expect(errorChainMessage(failure)).toMatch(pattern);
}

describe("workspace instruction-policy API and PostgreSQL authority", () => {
  test("preserves legacy behavior and enforces RBAC, scope, concurrency, rollback, audit, RLS, and immutability", async () => {
    const readOnlyCreate = await request(legacyGrant, "/instruction-policies/drafts", {
      method: "POST",
      permissions: ["workspace:read"],
      body: {
        kind: "charter",
        scope: "global",
        roleKey: null,
        content: "Unauthorized",
      },
    });
    expect(readOnlyCreate.status).toBe(403);

    const invalidScope = await request(legacyGrant, "/instruction-policies/drafts", {
      method: "POST",
      body: {
        kind: "charter",
        scope: "role",
        roleKey: "operator",
        content: "Invalid charter scope",
      },
    });
    expect(invalidScope.status).toBe(422);

    const importedResponse = await request(legacyGrant, "/instruction-policies/import-legacy", {
      method: "POST",
      body: {},
    });
    expect(importedResponse.status).toBe(201);
    const imported = (await importedResponse.json()) as Record<string, any>;
    expect(imported).toMatchObject({
      kind: "charter",
      scope: "global",
      roleKey: null,
      content: "LEGACY WORKSPACE PERSONA {{core}}",
      provenance: { source: "legacy_import", sourceId: "workspaces.agent_instructions" },
    });
    const callerLabeledImport = await request(legacyGrant, "/instruction-policies/import-legacy", {
      method: "POST",
      body: { sourceId: "caller-controlled" },
    });
    expect(callerLabeledImport.status).toBe(422);
    const forgedLegacyDraft = await request(legacyGrant, "/instruction-policies/drafts", {
      method: "POST",
      body: {
        kind: "charter",
        scope: "global",
        roleKey: null,
        content: "Caller-labeled legacy content",
        provenanceSource: "legacy_import",
        provenanceSourceId: "caller-controlled",
      },
    });
    expect(forgedLegacyDraft.status).toBe(422);
    expect((await getWorkspace(client.db, legacyGrant.workspaceId))?.agentInstructions).toBe(
      "LEGACY WORKSPACE PERSONA {{core}}",
    );

    await updateWorkspace(client.db, legacyGrant.workspaceId, {
      agentInstructions: "x".repeat(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS + 1),
    });
    const oversizedLegacyImport = await request(
      legacyGrant,
      "/instruction-policies/import-legacy",
      { method: "POST", body: {} },
    );
    expect(oversizedLegacyImport.status).toBe(422);
    expect(await oversizedLegacyImport.json()).toMatchObject({
      code: "INVALID_WORKSPACE_INSTRUCTION_POLICY_OPERATION",
    });
    await updateWorkspace(client.db, legacyGrant.workspaceId, {
      agentInstructions: "LEGACY WORKSPACE PERSONA {{core}}",
    });

    const importedList = await request(legacyGrant, "/instruction-policies");
    expect(importedList.status).toBe(200);
    expect(await importedList.json()).toMatchObject({
      revisions: [expect.objectContaining({ id: imported.id })],
      activeHeads: [],
      activationEvents: [],
    });

    const unavailableImport = await request(defaultGrant, "/instruction-policies/import-legacy", {
      method: "POST",
      body: {},
    });
    expect(unavailableImport.status).toBe(409);
    expect(await unavailableImport.json()).toMatchObject({
      code: "WORKSPACE_INSTRUCTION_POLICY_LEGACY_UNAVAILABLE",
    });
    expect((await getWorkspace(client.db, defaultGrant.workspaceId))?.agentInstructions).toBeNull();

    const globalA = await createDraft(legacyGrant, {
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "Prefer additive changes.\nRequire targeted tests.",
      provenanceSource: "onboarding",
      provenanceSourceId: "onboarding:v1",
    });
    const globalB = await createDraft(legacyGrant, {
      kind: "policy",
      scope: "global",
      roleKey: null,
      content: "Prefer additive changes.\nRequire PostgreSQL tests.",
      provenanceSource: "human",
      supersedesRevisionId: globalA.id,
    });
    const getDraftResponse = await request(legacyGrant, `/instruction-policies/${globalA.id}`, {
      permissions: ["workspace:read"],
    });
    expect(getDraftResponse.status).toBe(200);
    expect(await getDraftResponse.json()).toMatchObject({
      id: globalA.id,
      contentHash: globalA.contentHash,
    });
    const crossTargetSupersedes = await request(legacyGrant, "/instruction-policies/drafts", {
      method: "POST",
      body: {
        kind: "policy",
        scope: "role",
        roleKey: "operator",
        content: "Invalid supersedes target",
        supersedesRevisionId: globalA.id,
      },
    });
    expect(crossTargetSupersedes.status).toBe(422);
    const rolePolicy = await createDraft(legacyGrant, {
      kind: "policy",
      scope: "role",
      roleKey: "  Incident   RESPONDER  ",
      content: "Escalate production-impacting incidents.",
      provenanceSource: "knowledge_proposal",
      provenanceSourceId: "knowledge:proposal-7",
    });
    expect(rolePolicy).toMatchObject({
      roleKey: "incident-responder",
      provenance: { source: "knowledge_proposal", sourceId: "knowledge:proposal-7" },
    });
    expect(globalB.revision).toBeGreaterThan(globalA.revision);

    const diffResponse = await request(
      legacyGrant,
      `/instruction-policies/diff?fromRevisionId=${globalA.id}&toRevisionId=${globalB.id}`,
    );
    expect(diffResponse.status).toBe(200);
    const diff = (await diffResponse.json()) as Record<string, any>;
    expect(diff.format).toBe("unified");
    expect(diff.diff).toContain("-Require targeted tests.");
    expect(diff.diff).toContain("+Require PostgreSQL tests.");
    const crossTargetDiff = await request(
      legacyGrant,
      `/instruction-policies/diff?fromRevisionId=${globalA.id}&toRevisionId=${rolePolicy.id}`,
      { permissions: ["workspace:read"] },
    );
    expect(crossTargetDiff.status).toBe(422);

    const activationBody = { expectedCurrentRevisionId: null, reason: "Initial policy" };
    const concurrent = await Promise.all([
      request(legacyGrant, `/instruction-policies/${globalA.id}/activate`, {
        method: "POST",
        body: activationBody,
      }),
      request(legacyGrant, `/instruction-policies/${globalB.id}/activate`, {
        method: "POST",
        body: activationBody,
      }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    const successResponse = concurrent.find((response) => response.status === 200)!;
    const conflictResponse = concurrent.find((response) => response.status === 409)!;
    const firstActivation = (await successResponse.json()) as Record<string, any>;
    const conflict = (await conflictResponse.json()) as Record<string, any>;
    const winnerId = firstActivation.head.revisionId as string;
    const loserId = winnerId === globalA.id ? globalB.id : globalA.id;
    expect(conflict).toMatchObject({
      code: "WORKSPACE_INSTRUCTION_POLICY_CONFLICT",
      currentHead: { revisionId: winnerId, activationVersion: 1 },
    });
    expect(firstActivation.event).toMatchObject({
      type: "activate",
      activationVersion: 1,
      oldRevision: null,
      newRevision: { id: winnerId },
      actorSubjectId: legacyGrant.subjectId,
      reason: "Initial policy",
    });

    const prematureRollback = await request(legacyGrant, "/instruction-policies/rollback", {
      method: "POST",
      body: {
        targetRevisionId: loserId,
        expectedCurrentRevisionId: winnerId,
        reason: "Never active",
      },
    });
    expect(prematureRollback.status).toBe(422);

    const readOnlyActivation = await request(
      legacyGrant,
      `/instruction-policies/${rolePolicy.id}/activate`,
      {
        method: "POST",
        permissions: ["workspace:read"],
        body: { expectedCurrentRevisionId: null, reason: "Not allowed" },
      },
    );
    expect(readOnlyActivation.status).toBe(403);

    const secondActivationResponse = await request(
      legacyGrant,
      `/instruction-policies/${loserId}/activate`,
      {
        method: "POST",
        body: { expectedCurrentRevisionId: winnerId, reason: "Adopt reviewed draft" },
      },
    );
    expect(secondActivationResponse.status).toBe(200);
    const secondActivation = (await secondActivationResponse.json()) as Record<string, any>;
    expect(secondActivation.event).toMatchObject({
      type: "activate",
      activationVersion: 2,
      oldRevision: { id: winnerId },
      newRevision: { id: loserId },
      actorSubjectId: legacyGrant.subjectId,
      reason: "Adopt reviewed draft",
    });

    const rollbackResponse = await request(legacyGrant, "/instruction-policies/rollback", {
      method: "POST",
      body: {
        targetRevisionId: winnerId,
        expectedCurrentRevisionId: loserId,
        reason: "Restore known-good policy",
      },
    });
    expect(rollbackResponse.status).toBe(200);
    const rollback = (await rollbackResponse.json()) as Record<string, any>;
    expect(rollback).toMatchObject({
      head: { revisionId: winnerId, activationVersion: 3 },
      event: {
        type: "rollback",
        activationVersion: 3,
        oldRevision: { id: loserId },
        newRevision: { id: winnerId },
        actorSubjectId: legacyGrant.subjectId,
        reason: "Restore known-good policy",
      },
    });
    expect(Date.parse(rollback.event.createdAt)).not.toBeNaN();
    expect(rollback.event.oldRevision.contentHash).toHaveLength(64);
    expect(rollback.event.newRevision.contentHash).toHaveLength(64);

    const roleActivation = await request(
      legacyGrant,
      `/instruction-policies/${rolePolicy.id}/activate`,
      {
        method: "POST",
        body: { expectedCurrentRevisionId: null, reason: "Enable responder policy" },
      },
    );
    expect(roleActivation.status).toBe(200);
    const finalList = await request(legacyGrant, "/instruction-policies?limit=100", {
      permissions: ["workspace:read"],
    });
    expect(finalList.status).toBe(200);
    const listed = (await finalList.json()) as Record<string, any>;
    expect(listed.activeHeads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "policy", scope: "global", revisionId: winnerId }),
        expect.objectContaining({
          kind: "policy",
          scope: "role",
          roleKey: "incident-responder",
          revisionId: rolePolicy.id,
        }),
      ]),
    );
    expect(listed.activationEvents[0]).toMatchObject({
      actorSubjectId: legacyGrant.subjectId,
    });

    await expectDatabaseFailure(
      withRlsContext(
        client.db,
        { accountId: legacyGrant.accountId, workspaceId: legacyGrant.workspaceId },
        async (scopedDb) =>
          await scopedDb
            .update(dbSchema.workspaceInstructionPolicyRevisions)
            .set({ content: "Mutated history" })
            .where(eq(dbSchema.workspaceInstructionPolicyRevisions.id, winnerId)),
      ),
      /permission denied|violates check constraint/i,
    );
    expect(
      (await getWorkspaceInstructionPolicyRevision(client.db, legacyGrant.workspaceId, winnerId))
        .content,
    ).not.toBe("Mutated history");
    await expectDatabaseFailure(
      withRlsContext(
        client.db,
        { accountId: legacyGrant.accountId, workspaceId: legacyGrant.workspaceId },
        async (scopedDb) =>
          await scopedDb
            .delete(dbSchema.workspaceInstructionPolicyActivationEvents)
            .where(eq(dbSchema.workspaceInstructionPolicyActivationEvents.id, rollback.event.id)),
      ),
      /permission denied/i,
    );
    await expectDatabaseFailure(
      shared.admin`
        UPDATE workspace_instruction_policy_revisions
        SET created_by_subject_id = 'user:mutated-history'
        WHERE id = ${winnerId}
      `,
      /instruction-policy history is immutable/i,
    );
    await expectDatabaseFailure(
      shared.admin`
        DELETE FROM workspace_instruction_policy_activation_events
        WHERE id = ${rollback.event.id}
      `,
      /instruction-policy history is immutable/i,
    );

    const defaultDraft = await createDraft(defaultGrant, {
      kind: "charter",
      scope: "global",
      roleKey: null,
      content: "Inactive draft in default workspace",
    });
    const visibleFromLegacyContext = await withRlsContext(
      client.db,
      { accountId: legacyGrant.accountId, workspaceId: legacyGrant.workspaceId },
      async (scopedDb) =>
        await scopedDb
          .select({ workspaceId: dbSchema.workspaceInstructionPolicyRevisions.workspaceId })
          .from(dbSchema.workspaceInstructionPolicyRevisions),
    );
    expect(visibleFromLegacyContext.length).toBeGreaterThan(0);
    expect(
      visibleFromLegacyContext.every((row) => row.workspaceId === legacyGrant.workspaceId),
    ).toBe(true);
    expect(
      visibleFromLegacyContext.some((row) => row.workspaceId === defaultDraft.workspaceId),
    ).toBe(false);

    const invalidHash = createHash("sha256").update("Invalid scope", "utf8").digest("hex");
    await expectDatabaseFailure(
      shared.admin`
          INSERT INTO workspace_instruction_policy_revisions (
            account_id, workspace_id, kind, scope, role_key, content, content_hash,
            provenance_source, created_by_subject_id
          ) VALUES (
            ${legacyGrant.accountId}, ${legacyGrant.workspaceId}, 'charter', 'role', 'Operator',
            'Invalid scope', ${invalidHash}, 'human', ${legacyGrant.subjectId}
          )
        `,
      /check constraint/i,
    );

    const noncanonicalRoleHash = createHash("sha256")
      .update("Noncanonical role key", "utf8")
      .digest("hex");
    await expectDatabaseFailure(
      shared.admin`
        INSERT INTO workspace_instruction_policy_revisions (
          account_id, workspace_id, kind, scope, role_key, content, content_hash,
          provenance_source, created_by_subject_id
        ) VALUES (
          ${legacyGrant.accountId}, ${legacyGrant.workspaceId}, 'policy', 'role',
          'incident--responder', 'Noncanonical role key', ${noncanonicalRoleHash},
          'human', ${legacyGrant.subjectId}
        )
      `,
      /check constraint/i,
    );

    const loser = loserId === globalA.id ? globalA : globalB;
    await expectDatabaseFailure(
      shared.admin`
          INSERT INTO workspace_instruction_policy_heads (
            account_id, workspace_id, kind, scope, role_key, revision_id, revision,
            content_hash, activation_version
          ) VALUES (
            ${legacyGrant.accountId}, ${legacyGrant.workspaceId}, 'policy', 'global', NULL,
            ${loser.id}, ${loser.revision}, ${loser.contentHash}, 99
          )
        `,
      /duplicate key/i,
    );

    const [posture] = await shared.admin<
      Array<{
        revisions_force: boolean;
        heads_force: boolean;
        events_force: boolean;
        revisions_update: boolean;
        heads_update: boolean;
        events_update: boolean;
      }>
    >`
        SELECT
          (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'workspace_instruction_policy_revisions') AS revisions_force,
          (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'workspace_instruction_policy_heads') AS heads_force,
          (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'workspace_instruction_policy_activation_events') AS events_force,
          has_table_privilege('opengeni_app', 'workspace_instruction_policy_revisions', 'UPDATE') AS revisions_update,
          has_table_privilege('opengeni_app', 'workspace_instruction_policy_heads', 'UPDATE') AS heads_update,
          has_table_privilege('opengeni_app', 'workspace_instruction_policy_activation_events', 'UPDATE') AS events_update
      `;
    expect(posture).toEqual({
      revisions_force: true,
      heads_force: true,
      events_force: true,
      revisions_update: false,
      heads_update: true,
      events_update: false,
    });
  }, 180_000);
});
