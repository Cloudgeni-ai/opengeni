import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
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

const SECRET = "workspace-instruction-policy-onboarding-proposal-test-secret-32-bytes";

type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let workspaceGrant: Grant;
let siblingWorkspaceGrant: Grant;
let otherAccountGrant: Grant;

beforeAll(async () => {
  const explicitAdminUrl =
    process.env.OPENGENI_WORKSPACE_INSTRUCTION_POLICY_PROPOSAL_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_WORKSPACE_INSTRUCTION_POLICY_PROPOSAL_TEST_APP_URL;
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
    const acquired = await acquireSharedTestDatabase(
      "workspace-instruction-policy-onboarding-proposals",
    );
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
  }
  client = createDb(shared.appUrl);
  const accountExternalId = `proposal-account-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId,
    accountName: "Proposal account",
    workspaceExternalSource: "test",
    workspaceExternalId: `proposal-workspace-${crypto.randomUUID()}`,
    workspaceName: "Proposal workspace",
    subjectId: "user:proposal-admin",
  });
  workspaceGrant = access.workspaceGrants[0]!;
  const siblingAccess = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId,
    accountName: "Proposal account",
    workspaceExternalSource: "test",
    workspaceExternalId: `proposal-sibling-${crypto.randomUUID()}`,
    workspaceName: "Proposal sibling",
    subjectId: "user:proposal-admin",
  });
  siblingWorkspaceGrant = siblingAccess.workspaceGrants[0]!;
  const otherAccess = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `proposal-other-account-${crypto.randomUUID()}`,
    accountName: "Other proposal account",
    workspaceExternalSource: "test",
    workspaceExternalId: `proposal-other-workspace-${crypto.randomUUID()}`,
    workspaceName: "Other proposal workspace",
    subjectId: "user:proposal-admin",
  });
  otherAccountGrant = otherAccess.workspaceGrants[0]!;

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

async function bearerFor(
  grant: Grant,
  permissions: Permission[],
  subjectId = grant.subjectId,
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function request(
  grant: Grant,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    permissions?: Permission[];
    subjectId?: string;
    targetWorkspaceId?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: await bearerFor(
      grant,
      options.permissions ?? ["workspace:read", "workspace:admin"],
      options.subjectId,
    ),
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return await app.request(
    `http://x/v1/workspaces/${options.targetWorkspaceId ?? grant.workspaceId}${path}`,
    {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
  );
}

function proposalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: crypto.randomUUID(),
    kind: "policy",
    scope: "global",
    roleKey: null,
    content: "Require explicit confirmation before production mutations.",
    sourceId: "guided-onboarding",
    sourceVersion: "2026-08-03",
    confidenceBps: 9_500,
    expectedCurrentRevisionId: null,
    expectedActivationVersion: 0,
    ...overrides,
  };
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

describe("workspace instruction-policy onboarding proposals", () => {
  test("creates inactive replay-safe drafts and returns typed validation and conflict outcomes", async () => {
    const unauthorized = await request(workspaceGrant, "/instruction-policies/onboarding-proposals", {
      method: "POST",
      permissions: ["workspace:read"],
      body: proposalBody(),
    });
    expect(unauthorized.status).toBe(403);

    const empty = await request(workspaceGrant, "/instruction-policies/onboarding-proposals", {
      method: "POST",
      body: proposalBody({ content: " \n " }),
    });
    expect(empty.status).toBe(422);
    expect(await empty.json()).toMatchObject({
      code: "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_EMPTY",
      maxChars: WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
    });

    const oversized = await request(workspaceGrant, "/instruction-policies/onboarding-proposals", {
      method: "POST",
      body: proposalBody({
        content: "x".repeat(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS + 1),
      }),
    });
    expect(oversized.status).toBe(422);
    expect(await oversized.json()).toMatchObject({
      code: "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_OVERSIZED",
      maxChars: WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
    });

    const operationId = crypto.randomUUID();
    const createBody = proposalBody({ operationId });
    const createdResponse = await request(
      workspaceGrant,
      "/instruction-policies/onboarding-proposals",
      { method: "POST", body: createBody },
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as Record<string, any>;
    expect(created).toMatchObject({
      operationId,
      accountId: workspaceGrant.accountId,
      workspaceId: workspaceGrant.workspaceId,
      kind: "policy",
      scope: "global",
      roleKey: null,
      source: {
        id: "guided-onboarding",
        version: "2026-08-03",
        confidenceBps: 9_500,
      },
      baseline: null,
      status: "proposed",
      createdBySubjectId: workspaceGrant.subjectId,
      draft: {
        operationId,
        content: createBody.content,
        provenance: { source: "onboarding" },
        supersedesRevisionId: null,
      },
    });
    expect(created.draft.provenance.sourceId).toBe(created.id);

    const exactRetry = await request(
      workspaceGrant,
      "/instruction-policies/onboarding-proposals",
      { method: "POST", body: createBody },
    );
    expect(exactRetry.status).toBe(201);
    expect(await exactRetry.json()).toEqual(created);

    const changedReplay = await request(
      workspaceGrant,
      "/instruction-policies/onboarding-proposals",
      {
        method: "POST",
        body: { ...createBody, confidenceBps: 9_499 },
      },
    );
    expect(changedReplay.status).toBe(409);
    expect(await changedReplay.json()).toMatchObject({
      code: "WORKSPACE_INSTRUCTION_POLICY_OPERATION_REUSED",
    });

    const crossSubjectReplay = await request(
      workspaceGrant,
      "/instruction-policies/onboarding-proposals",
      {
        method: "POST",
        subjectId: "user:other-proposal-admin",
        body: createBody,
      },
    );
    expect(crossSubjectReplay.status).toBe(409);
    expect(await crossSubjectReplay.json()).toMatchObject({
      code: "WORKSPACE_INSTRUCTION_POLICY_OPERATION_REUSED",
    });

    const list = await request(
      workspaceGrant,
      "/instruction-policies/onboarding-proposals?limit=50",
      { permissions: ["workspace:read"] },
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      proposals: [expect.objectContaining({ id: created.id })],
      truncated: false,
    });
    const policyList = await request(workspaceGrant, "/instruction-policies?limit=100", {
      permissions: ["workspace:read"],
    });
    expect(policyList.status).toBe(200);
    expect(await policyList.json()).toMatchObject({
      revisions: [expect.objectContaining({ id: created.draft.id })],
      activeHeads: [],
      activationEvents: [],
    });

    const draftResponse = await request(workspaceGrant, "/instruction-policies/drafts", {
      method: "POST",
      body: {
        operationId: crypto.randomUUID(),
        kind: "policy",
        scope: "global",
        roleKey: null,
        content: "Require a rollback plan for production changes.",
        provenanceSource: "human",
      },
    });
    expect(draftResponse.status).toBe(201);
    const activeDraft = (await draftResponse.json()) as Record<string, any>;
    const activateResponse = await request(
      workspaceGrant,
      `/instruction-policies/${activeDraft.id}/activate`,
      {
        method: "POST",
        body: {
          operationId: crypto.randomUUID(),
          expectedCurrentRevisionId: null,
          expectedActivationVersion: 0,
          reason: "Establish an onboarding proposal baseline",
        },
      },
    );
    expect(activateResponse.status).toBe(200);
    const activation = (await activateResponse.json()) as Record<string, any>;

    const stale = await request(workspaceGrant, "/instruction-policies/onboarding-proposals", {
      method: "POST",
      body: proposalBody({
        sourceVersion: "2026-08-03.2",
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_STALE",
      currentHead: {
        revisionId: activeDraft.id,
        activationVersion: activation.head.activationVersion,
      },
    });

    const currentProposalBody = proposalBody({
      operationId: crypto.randomUUID(),
      sourceVersion: "2026-08-03.2",
      expectedCurrentRevisionId: activeDraft.id,
      expectedActivationVersion: activation.head.activationVersion,
    });
    const currentProposalResponse = await request(
      workspaceGrant,
      "/instruction-policies/onboarding-proposals",
      { method: "POST", body: currentProposalBody },
    );
    expect(currentProposalResponse.status).toBe(201);
    const currentProposal = (await currentProposalResponse.json()) as Record<string, any>;
    expect(currentProposal).toMatchObject({
      baseline: {
        revisionId: activeDraft.id,
        revision: activeDraft.revision,
        contentHash: activeDraft.contentHash,
        activationVersion: activation.head.activationVersion,
      },
      draft: { supersedesRevisionId: activeDraft.id },
    });

    const conflictingSourceVersion = await request(
      workspaceGrant,
      "/instruction-policies/onboarding-proposals",
      {
        method: "POST",
        body: {
          ...currentProposalBody,
          operationId: crypto.randomUUID(),
          content: "A conflicting draft from the same immutable onboarding source version.",
        },
      },
    );
    expect(conflictingSourceVersion.status).toBe(409);
    expect(await conflictingSourceVersion.json()).toMatchObject({
      code: "WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_CONFLICT",
      existingProposalId: currentProposal.id,
      existingDraftRevisionId: currentProposal.draft.id,
    });

    const [receipt] = await shared.admin<
      Array<{ operationId: string; requestFingerprint: string; createdBySubjectId: string }>
    >`
      SELECT
        operation_id::text AS "operationId",
        request_fingerprint AS "requestFingerprint",
        created_by_subject_id AS "createdBySubjectId"
      FROM workspace_instruction_policy_onboarding_proposals
      WHERE id = ${created.id}::uuid
    `;
    expect(receipt).toEqual({
      operationId,
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      createdBySubjectId: workspaceGrant.subjectId,
    });
    const [draftReceipt] = await shared.admin<
      Array<{ operationId: string; requestFingerprint: string; provenanceSourceId: string }>
    >`
      SELECT
        operation_id::text AS "operationId",
        request_fingerprint AS "requestFingerprint",
        provenance_source_id AS "provenanceSourceId"
      FROM workspace_instruction_policy_revisions
      WHERE id = ${created.draft.id}::uuid
    `;
    expect(draftReceipt).toEqual({
      operationId,
      requestFingerprint: receipt!.requestFingerprint,
      provenanceSourceId: created.id,
    });
  }, 120_000);

  test("keeps proposal identity isolated across organizations and workspaces", async () => {
    const sibling = await request(
      siblingWorkspaceGrant,
      "/instruction-policies/onboarding-proposals",
      { method: "POST", body: proposalBody() },
    );
    expect(sibling.status).toBe(201);
    const siblingProposal = (await sibling.json()) as Record<string, any>;

    const otherAccount = await request(
      otherAccountGrant,
      "/instruction-policies/onboarding-proposals",
      { method: "POST", body: proposalBody() },
    );
    expect(otherAccount.status).toBe(201);
    const otherAccountProposal = (await otherAccount.json()) as Record<string, any>;

    const crossWorkspaceRoute = await request(
      workspaceGrant,
      "/instruction-policies/onboarding-proposals",
      {
        method: "POST",
        targetWorkspaceId: siblingWorkspaceGrant.workspaceId,
        body: proposalBody({ sourceVersion: "cross-workspace-denied" }),
      },
    );
    expect(crossWorkspaceRoute.status).toBe(403);

    const siblingContextLeak = await withRlsContext(
      client.db,
      {
        accountId: siblingWorkspaceGrant.accountId,
        workspaceId: siblingWorkspaceGrant.workspaceId,
      },
      async (scopedDb) =>
        await scopedDb
          .select({ id: dbSchema.workspaceInstructionPolicyOnboardingProposals.id })
          .from(dbSchema.workspaceInstructionPolicyOnboardingProposals)
          .where(eq(dbSchema.workspaceInstructionPolicyOnboardingProposals.id, otherAccountProposal.id)),
    );
    expect(siblingContextLeak).toEqual([]);

    const otherAccountContextLeak = await withRlsContext(
      client.db,
      { accountId: otherAccountGrant.accountId, workspaceId: otherAccountGrant.workspaceId },
      async (scopedDb) =>
        await scopedDb
          .select({ id: dbSchema.workspaceInstructionPolicyOnboardingProposals.id })
          .from(dbSchema.workspaceInstructionPolicyOnboardingProposals)
          .where(eq(dbSchema.workspaceInstructionPolicyOnboardingProposals.id, siblingProposal.id)),
    );
    expect(otherAccountContextLeak).toEqual([]);

    const appRole = decodeURIComponent(new URL(shared.appUrl).username);
    const [posture] = await shared.admin<
      Array<{ rowSecurity: boolean; forceRowSecurity: boolean }>
    >`
      SELECT
        c.relrowsecurity AS "rowSecurity",
        c.relforcerowsecurity AS "forceRowSecurity"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relname = 'workspace_instruction_policy_onboarding_proposals'
    `;
    expect(posture).toEqual({ rowSecurity: true, forceRowSecurity: true });
    const privileges = await shared.admin<Array<{ privilege: string }>>`
      SELECT privilege_type AS privilege
      FROM information_schema.role_table_grants
      WHERE table_schema = current_schema()
        AND table_name = 'workspace_instruction_policy_onboarding_proposals'
        AND grantee = ${appRole}
      ORDER BY privilege_type
    `;
    expect(privileges.map((row) => row.privilege)).toEqual(["INSERT", "SELECT"]);
  }, 120_000);

  test("rejects direct proposal mutation and forged draft linkage", async () => {
    const created = await request(
      siblingWorkspaceGrant,
      "/instruction-policies/onboarding-proposals",
      {
        method: "POST",
        body: proposalBody({ sourceVersion: `immutable-${crypto.randomUUID()}` }),
      },
    );
    expect(created.status).toBe(201);
    const proposal = (await created.json()) as Record<string, any>;

    await expectDatabaseFailure(
      withRlsContext(
        client.db,
        {
          accountId: siblingWorkspaceGrant.accountId,
          workspaceId: siblingWorkspaceGrant.workspaceId,
        },
        async (scopedDb) =>
          await scopedDb
            .update(dbSchema.workspaceInstructionPolicyOnboardingProposals)
            .set({ confidenceBps: 1 })
            .where(eq(dbSchema.workspaceInstructionPolicyOnboardingProposals.id, proposal.id)),
      ),
      /history is immutable|permission denied/i,
    );
    await expectDatabaseFailure(
      withRlsContext(
        client.db,
        {
          accountId: siblingWorkspaceGrant.accountId,
          workspaceId: siblingWorkspaceGrant.workspaceId,
        },
        async (scopedDb) =>
          await scopedDb
            .delete(dbSchema.workspaceInstructionPolicyOnboardingProposals)
            .where(eq(dbSchema.workspaceInstructionPolicyOnboardingProposals.id, proposal.id)),
      ),
      /history is immutable|permission denied/i,
    );

    await expectDatabaseFailure(
      shared.admin`
        INSERT INTO workspace_instruction_policy_onboarding_proposals (
          operation_id,
          request_fingerprint,
          account_id,
          workspace_id,
          kind,
          scope,
          role_key,
          source_id,
          source_version,
          confidence_bps,
          baseline_activation_version,
          draft_revision_id,
          draft_revision,
          draft_content_hash,
          created_by_subject_id
        ) VALUES (
          ${crypto.randomUUID()}::uuid,
          ${"f".repeat(64)},
          ${siblingWorkspaceGrant.accountId}::uuid,
          ${siblingWorkspaceGrant.workspaceId}::uuid,
          'policy',
          'global',
          NULL,
          'forged',
          'v1',
          10000,
          0,
          ${proposal.draft.id}::uuid,
          ${proposal.draft.revision},
          ${proposal.draft.contentHash},
          ${siblingWorkspaceGrant.subjectId}
        )
      `,
      /must identify its exact inactive draft/i,
    );
  }, 120_000);
});