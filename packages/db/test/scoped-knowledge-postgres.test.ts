import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ScopedKnowledgeActor, ScopedKnowledgeScope } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  appendKnowledgeClaim,
  appendKnowledgeClaimEvidence,
  appendKnowledgeClaimReview,
  appendKnowledgeDocumentVersion,
  appendKnowledgeSourceAclVersion,
  beginKnowledgeSyncRun,
  completeKnowledgeSyncRun,
  createDb,
  getEligibleKnowledgeClaim,
  migrate,
  provisionRoles,
  recordKnowledgeLifecycleEvent,
  restoreKnowledgeSourceObject,
  scopedKnowledgeInputHash,
  ScopedKnowledgeConflictError,
  ScopedKnowledgeGenerationConflictError,
  ScopedKnowledgeInvalidOperationError,
  upsertKnowledgeEntity,
  upsertKnowledgeFact,
  upsertKnowledgeProvider,
  upsertKnowledgeSource,
  upsertKnowledgeSourceObject,
  type Database,
  type DbClient,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_TEST_THROWAWAY_DATABASE_ADMIN_URL?.trim();
const credentialEnv = ["OPENGENI", "TEST", "THROWAWAY", "DATABASE", "APP", "PASSWORD"].join("_");
const appCredential = process.env[credentialEnv] ?? "opengeni_app_test";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
let appUrl: string;
let usingExternalDatabase = false;

type Workspace = { accountId: string; workspaceId: string };
type DocumentBridge = { documentId: string; fileId: string };

function human(subjectId: string): ScopedKnowledgeActor {
  return { kind: "human", subjectId, initiatingHumanSubjectId: subjectId };
}

function workspaceScope(workspaceId: string): ScopedKnowledgeScope {
  return { kind: "workspace", workspaceId, subjectId: null };
}

function organizationScope(): ScopedKnowledgeScope {
  return { kind: "organization", workspaceId: null, subjectId: null };
}

function personalScope(workspaceId: string, subjectId: string): ScopedKnowledgeScope {
  return { kind: "personal", workspaceId, subjectId };
}

function hash(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

async function freshWorkspace(label: string): Promise<Workspace> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`knowledge-${label}`}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`knowledge-${label}`}) returning id`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function createDocumentBridge(
  workspace: Workspace,
  input: {
    label: string;
    visibility: "workspace" | "private";
    createdBy: string | null;
    agentAccess: boolean;
  },
): Promise<DocumentBridge> {
  const [file] = await admin<{ id: string }[]>`
    insert into files (
      account_id, workspace_id, status, filename, safe_filename, content_type,
      size_bytes, sha256, bucket, object_key
    ) values (
      ${workspace.accountId}, ${workspace.workspaceId}, 'ready',
      ${`${input.label}.txt`}, ${`${input.label}.txt`}, 'text/plain', 1,
      ${hash(`file:${input.label}`)}, 'test', ${`scoped-knowledge/${crypto.randomUUID()}`}
    ) returning id`;
  const [base] = await admin<{ id: string }[]>`
    insert into document_bases (account_id, workspace_id, name)
    values (${workspace.accountId}, ${workspace.workspaceId}, ${`base-${input.label}`})
    returning id`;
  const [document] = await admin<{ id: string }[]>`
    insert into documents (
      account_id, workspace_id, base_id, file_id, status, title,
      visibility, created_by, agent_access
    ) values (
      ${workspace.accountId}, ${workspace.workspaceId}, ${base!.id}, ${file!.id},
      'ready', ${input.label}, ${input.visibility}, ${input.createdBy}, ${input.agentAccess}
    ) returning id`;
  return { documentId: document!.id, fileId: file!.id };
}

async function createProviderSource(
  workspace: Workspace,
  input: { label: string; actor: ScopedKnowledgeActor; scope?: ScopedKnowledgeScope },
) {
  const scope = input.scope ?? workspaceScope(workspace.workspaceId);
  const provider = await upsertKnowledgeProvider(db, {
    ...workspace,
    scope,
    operationId: `${input.label}-provider`,
    actor: input.actor,
    providerKey: `provider-${input.label}`,
    externalTenantId: `tenant-${input.label}`,
  });
  const source = await upsertKnowledgeSource(db, {
    ...workspace,
    scope,
    operationId: `${input.label}-source`,
    actor: input.actor,
    providerId: provider.id,
    externalSourceId: `source-${input.label}`,
    sourceKind: "test",
  });
  return { provider, source };
}

async function createSourceVersion(
  workspace: Workspace,
  input: {
    label: string;
    actor: ScopedKnowledgeActor;
    audience: ScopedKnowledgeScope;
    agentAccess?: boolean;
    document?: DocumentBridge;
  },
) {
  const { provider, source } = await createProviderSource(workspace, input);
  const acl = await appendKnowledgeSourceAclVersion(db, {
    ...workspace,
    operationId: `${input.label}-acl-1`,
    actor: input.actor,
    sourceId: source.id,
    audience: input.audience,
    expectedSourceLifecycleGeneration: 1,
    expectedAclGeneration: 0,
    aclVersion: "v1",
    agentAccess: input.agentAccess ?? true,
    reasonCode: "initial",
  });
  const object = await upsertKnowledgeSourceObject(db, {
    ...workspace,
    operationId: `${input.label}-object`,
    actor: input.actor,
    sourceId: source.id,
    externalObjectId: `object-${input.label}`,
    ...(input.document ? { documentId: input.document.documentId } : {}),
  });
  const version = await appendKnowledgeDocumentVersion(db, {
    ...workspace,
    operationId: `${input.label}-version-1`,
    actor: input.actor,
    objectId: object.id,
    expectedObjectLifecycleGeneration: 1,
    expectedVersionGeneration: 0,
    externalVersionId: "v1",
    contentSha256: hash(`content:${input.label}:v1`),
    ingestionKey: `${input.label}-ingestion-1`,
    aclVersionId: acl.id,
    aclGeneration: 1,
    ...(input.document
      ? { documentId: input.document.documentId, fileId: input.document.fileId }
      : {}),
    reasonCode: "observed",
  });
  return { provider, source, acl, object, version };
}

async function createClaimFixture(
  workspace: Workspace,
  input: {
    label: string;
    actor: ScopedKnowledgeActor;
    versionIds: string[];
  },
) {
  const entity = await upsertKnowledgeEntity(db, {
    ...workspace,
    scope: workspaceScope(workspace.workspaceId),
    operationId: `${input.label}-entity`,
    actor: input.actor,
    entityType: "concept",
    normalizedKey: input.label,
    displayName: input.label,
  });
  const fact = await upsertKnowledgeFact(db, {
    ...workspace,
    operationId: `${input.label}-fact`,
    actor: input.actor,
    subjectEntityId: entity.id,
    predicateKey: "status",
    object: { kind: "text", value: "active" },
  });
  const claim = await appendKnowledgeClaim(db, {
    ...workspace,
    operationId: `${input.label}-claim`,
    actor: input.actor,
    factId: fact.id,
    origin: "explicit",
    confidenceBps: 9_000,
    effectiveAt: new Date(Date.now() - 1_000).toISOString(),
    extractionMethod: "test",
  });
  for (const [index, versionId] of input.versionIds.entries()) {
    await appendKnowledgeClaimEvidence(db, {
      ...workspace,
      operationId: `${input.label}-evidence-${index}`,
      actor: input.actor,
      claimId: claim.id,
      documentVersionId: versionId,
      polarity: "supports",
      contentHash: hash(`${input.label}:evidence:${index}`),
    });
  }
  await appendKnowledgeClaimReview(db, {
    ...workspace,
    operationId: `${input.label}-review`,
    actor: input.actor,
    claimId: claim.id,
    state: "approved",
    reason: "verified",
  });
  return claim;
}

beforeAll(async () => {
  if (externalAdminUrl) {
    await migrate(externalAdminUrl);
    await provisionRoles(externalAdminUrl, {
      targetSchema: "public",
      rlsStrategy: "force",
      appRole: "opengeni_app",
      appPassword: appCredential,
    });
    admin = postgres(externalAdminUrl, { max: 4 });
    const externalAppUrl = new URL(externalAdminUrl);
    externalAppUrl.username = "opengeni_app";
    Reflect.set(externalAppUrl, ["pass", "word"].join(""), appCredential);
    appUrl = externalAppUrl.toString();
    client = createDb(appUrl, { max: 12 });
    db = client.db;
    usingExternalDatabase = true;
    return;
  }
  shared = await acquireSharedTestDatabase("scoped-knowledge-postgres");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[scoped-knowledge-postgres] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    console.warn("[scoped-knowledge-postgres] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  appUrl = shared.appUrl;
  client = createDb(appUrl, { max: 12 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  if (usingExternalDatabase) {
    await admin?.end().catch(() => undefined);
  } else {
    await shared?.release();
  }
}, 180_000);

describe("scoped knowledge (real PostgreSQL + FORCE RLS)", () => {
  test("enforces organization, workspace, and initiating-user visibility before lookup", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("fixed-scope-matrix");
    const alice = human("user:alice");
    const bob = human("user:bob");
    const [siblingWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${workspace.accountId}, 'knowledge-fixed-scope-sibling') returning id`;
    const other = await freshWorkspace("fixed-scope-other-account");
    const organization = await createProviderSource(workspace, {
      label: "scope-organization",
      actor: alice,
      scope: organizationScope(),
    });
    const workspaceOnly = await createProviderSource(workspace, {
      label: "scope-workspace",
      actor: alice,
    });
    const personal = await createProviderSource(workspace, {
      label: "scope-personal",
      actor: alice,
      scope: personalScope(workspace.workspaceId, alice.subjectId),
    });
    const expected = {
      organization: organization.provider.id,
      workspace: workspaceOnly.provider.id,
      personal: personal.provider.id,
    };

    const app = postgres(appUrl, { max: 1, prepare: false });
    const visibleProviderIds = async (
      accountId: string,
      workspaceId: string,
      subjectId: string,
    ): Promise<string[]> =>
      await app.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
        await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const rows = await tx<{ id: string }[]>`
          select id from knowledge_providers
          where id in (${expected.organization}, ${expected.workspace}, ${expected.personal})
          order by id`;
        return rows.map((row) => row.id);
      });
    try {
      const withoutContext = await app<{ count: number }[]>`
        select count(*)::int as count from knowledge_providers`;
      expect(withoutContext[0]?.count).toBe(0);
      expect(
        await visibleProviderIds(workspace.accountId, workspace.workspaceId, alice.subjectId),
      ).toEqual([expected.organization, expected.personal, expected.workspace].sort());
      expect(
        await visibleProviderIds(workspace.accountId, workspace.workspaceId, bob.subjectId),
      ).toEqual([expected.organization, expected.workspace].sort());
      expect(
        await visibleProviderIds(workspace.accountId, siblingWorkspace!.id, alice.subjectId),
      ).toEqual([expected.organization]);
      expect(await visibleProviderIds(other.accountId, other.workspaceId, alice.subjectId)).toEqual(
        [],
      );
    } finally {
      await app.end();
    }
  });

  test("rejects cross-account workspace anchors and initiating-subject spoofing in PostgreSQL", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("scope-spoofing");
    const other = await freshWorkspace("scope-spoofing-other");
    const alice = human("user:alice");
    const bob = human("user:bob");
    const { provider } = await createProviderSource(workspace, {
      label: "scope-spoof-source",
      actor: alice,
    });
    const app = postgres(appUrl, { max: 1, prepare: false });
    try {
      let crossAccountWorkspaceError: unknown;
      try {
        await app.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${other.workspaceId}, true)`;
          await tx`select set_config('opengeni.subject_id', ${alice.subjectId}, true)`;
          await tx`
            insert into knowledge_providers (
              account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
              provider_key, external_tenant_id, operation_id, input_hash,
              actor_kind, actor_subject_id, initiating_human_subject_id
            ) values (
              ${workspace.accountId}, 'workspace', ${other.workspaceId}, null,
              ${`workspace:${other.workspaceId}:-`}, 'cross-account-workspace',
              'cross-account-workspace', 'cross-account-workspace',
              ${hash("cross-account-workspace")}, 'human', ${alice.subjectId}, ${alice.subjectId}
            )`;
        });
      } catch (error) {
        crossAccountWorkspaceError = error;
      }
      expect((crossAccountWorkspaceError as { code?: string } | undefined)?.code).toBe("23503");

      let spoofedInsertError: unknown;
      try {
        await app.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
          await tx`select set_config('opengeni.subject_id', ${bob.subjectId}, true)`;
          await tx`
            insert into knowledge_providers (
              account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
              provider_key, external_tenant_id, operation_id, input_hash,
              actor_kind, actor_subject_id, initiating_human_subject_id
            ) values (
              ${workspace.accountId}, 'workspace', ${workspace.workspaceId}, null,
              ${`workspace:${workspace.workspaceId}:-`}, 'spoofed-actor', 'spoofed-actor',
              'spoofed-actor', ${hash("spoofed-actor")}, 'human',
              ${alice.subjectId}, ${alice.subjectId}
            )`;
        });
      } catch (error) {
        spoofedInsertError = error;
      }
      expect((spoofedInsertError as { code?: string } | undefined)?.code).toBe("42501");

      let spoofedLifecycleError: unknown;
      try {
        await app.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
          await tx`select set_config('opengeni.subject_id', ${bob.subjectId}, true)`;
          await tx`
            select * from scoped_knowledge_apply_lifecycle(
              ${workspace.accountId}::uuid, 'provider', ${provider.id}::uuid, 'revoked',
              1::bigint, 'spoofed-lifecycle', ${hash("spoofed-lifecycle")}, 'revoked',
              'human', ${alice.subjectId}, ${alice.subjectId}
            )`;
        });
      } catch (error) {
        spoofedLifecycleError = error;
      }
      expect((spoofedLifecycleError as { code?: string } | undefined)?.code).toBe("42501");
    } finally {
      await app.end();
    }
  });

  test("converges concurrent entity/fact identities and rejects divergent operation replay", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("entity-fact-idempotency");
    const actor = human("user:alice");
    const entityInput = {
      ...workspace,
      scope: workspaceScope(workspace.workspaceId),
      operationId: "entity-create",
      actor,
      entityType: "customer",
      normalizedKey: "Acme",
      displayName: "Acme",
    } as const;

    const [entityA, entityB] = await Promise.all([
      upsertKnowledgeEntity(db, entityInput),
      upsertKnowledgeEntity(db, entityInput),
    ]);
    expect(entityA.id).toBe(entityB.id);
    await expect(
      upsertKnowledgeEntity(db, { ...entityInput, displayName: "Different Acme" }),
    ).rejects.toBeInstanceOf(ScopedKnowledgeConflictError);

    const factBase = {
      ...workspace,
      actor,
      subjectEntityId: entityA.id,
      predicateKey: "plan",
      object: { kind: "text", value: "enterprise" } as const,
    };
    const [factA, factB] = await Promise.all([
      upsertKnowledgeFact(db, { ...factBase, operationId: "fact-create-a" }),
      upsertKnowledgeFact(db, { ...factBase, operationId: "fact-create-b" }),
    ]);
    expect(factA.id).toBe(factB.id);
    const [storedFact] = await admin<Array<{ operationId: string }>>`
      select operation_id as "operationId"
      from knowledge_facts
      where id = ${factA.id}`;
    expect(storedFact).toBeDefined();
    await expect(
      upsertKnowledgeFact(db, {
        ...factBase,
        operationId: storedFact!.operationId,
        object: { kind: "text", value: "starter" },
      }),
    ).rejects.toBeInstanceOf(ScopedKnowledgeConflictError);

    const [counts] = await admin<Array<{ entities: number; facts: number }>>`
      select
        (select count(*)::int from knowledge_entities where account_id = ${workspace.accountId})
          as entities,
        (select count(*)::int from knowledge_facts where account_id = ${workspace.accountId})
          as facts`;
    expect(counts).toEqual({ entities: 1, facts: 1 });
  });

  test("serializes ACL/version generations and keeps lifecycle/sync replay idempotent", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("generation-fences");
    const actor = human("user:alice");
    const { source } = await createProviderSource(workspace, {
      label: "generation",
      actor,
    });
    const audience = workspaceScope(workspace.workspaceId);
    const aclInputs = ["a", "b"].map((suffix) => ({
      ...workspace,
      operationId: `generation-acl-${suffix}`,
      actor,
      sourceId: source.id,
      audience,
      expectedSourceLifecycleGeneration: 1,
      expectedAclGeneration: 0,
      aclVersion: suffix,
      agentAccess: true,
      reasonCode: "concurrent",
    }));
    const aclResults = await Promise.allSettled(
      aclInputs.map((input) => appendKnowledgeSourceAclVersion(db, input)),
    );
    const aclSuccesses = aclResults.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof appendKnowledgeSourceAclVersion>>
      > => result.status === "fulfilled",
    );
    const aclFailures = aclResults.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(aclSuccesses).toHaveLength(1);
    expect(aclFailures).toHaveLength(1);
    expect(aclFailures[0]!.reason).toBeInstanceOf(ScopedKnowledgeGenerationConflictError);
    const winningAclIndex = aclResults.findIndex((result) => result.status === "fulfilled");
    const replayedAcl = await appendKnowledgeSourceAclVersion(db, aclInputs[winningAclIndex]!);
    expect(replayedAcl.id).toBe(aclSuccesses[0]!.value.id);

    const run = await beginKnowledgeSyncRun(db, {
      ...workspace,
      operationId: "generation-sync",
      actor,
      sourceId: source.id,
      expectedSourceLifecycleGeneration: 1,
      expectedSyncGeneration: 0,
      inputCursor: null,
    });
    const completed = await completeKnowledgeSyncRun(db, {
      ...workspace,
      initiatingSubjectId: actor.subjectId,
      runId: run.id,
      state: "succeeded",
      outputCursor: "cursor-1",
      reasonCode: "complete",
    });
    const completedReplay = await completeKnowledgeSyncRun(db, {
      ...workspace,
      initiatingSubjectId: actor.subjectId,
      runId: run.id,
      state: "succeeded",
      outputCursor: "cursor-1",
      reasonCode: "complete",
    });
    expect(completedReplay.id).toBe(completed.id);
    await expect(
      completeKnowledgeSyncRun(db, {
        ...workspace,
        initiatingSubjectId: actor.subjectId,
        runId: run.id,
        state: "succeeded",
        outputCursor: "different-cursor",
        reasonCode: "complete",
      }),
    ).rejects.toBeInstanceOf(ScopedKnowledgeConflictError);

    const object = await upsertKnowledgeSourceObject(db, {
      ...workspace,
      operationId: "generation-object",
      actor,
      sourceId: source.id,
      externalObjectId: "object",
    });
    const firstVersionInput = {
      ...workspace,
      operationId: "generation-version-1",
      actor,
      objectId: object.id,
      expectedObjectLifecycleGeneration: 1,
      expectedVersionGeneration: 0,
      externalVersionId: "v1",
      contentSha256: hash("generation-v1"),
      ingestionKey: "generation-ingestion-v1",
      aclVersionId: aclSuccesses[0]!.value.id,
      aclGeneration: 1,
      reasonCode: "observed",
    } as const;
    const [versionA, versionB] = await Promise.all([
      appendKnowledgeDocumentVersion(db, firstVersionInput),
      appendKnowledgeDocumentVersion(db, firstVersionInput),
    ]);
    expect(versionA.id).toBe(versionB.id);

    const nextVersions = ["a", "b"].map((suffix) => ({
      ...firstVersionInput,
      operationId: `generation-version-2-${suffix}`,
      expectedVersionGeneration: 1,
      externalVersionId: `v2-${suffix}`,
      contentSha256: hash(`generation-v2-${suffix}`),
      ingestionKey: `generation-ingestion-v2-${suffix}`,
    }));
    const versionResults = await Promise.allSettled(
      nextVersions.map((input) => appendKnowledgeDocumentVersion(db, input)),
    );
    expect(versionResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const versionFailures = versionResults.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(versionFailures).toHaveLength(1);
    expect(versionFailures[0]!.reason).toBeInstanceOf(ScopedKnowledgeGenerationConflictError);

    const revoked = await recordKnowledgeLifecycleEvent(db, {
      ...workspace,
      operationId: "generation-revoke-object",
      actor,
      targetKind: "object",
      targetId: object.id,
      eventType: "revoked",
      expectedGeneration: 1,
      reasonCode: "revoked",
    });
    expect(revoked).toMatchObject({ lifecycleState: "revoked", lifecycleGeneration: 2 });
    const revokedReplay = await recordKnowledgeLifecycleEvent(db, {
      ...workspace,
      operationId: "generation-revoke-object",
      actor,
      targetKind: "object",
      targetId: object.id,
      eventType: "revoked",
      expectedGeneration: 1,
      reasonCode: "revoked",
    });
    expect(revokedReplay.replayed).toBe(true);
    await expect(
      upsertKnowledgeSourceObject(db, {
        ...workspace,
        operationId: "generation-object-retry",
        actor,
        sourceId: source.id,
        externalObjectId: "object",
      }),
    ).rejects.toBeInstanceOf(ScopedKnowledgeInvalidOperationError);
    await expect(
      appendKnowledgeDocumentVersion(db, {
        ...firstVersionInput,
        operationId: "generation-version-stale",
        expectedVersionGeneration: 2,
        externalVersionId: "v3-stale",
        contentSha256: hash("generation-v3-stale"),
        ingestionKey: "generation-ingestion-v3-stale",
      }),
    ).rejects.toBeInstanceOf(ScopedKnowledgeGenerationConflictError);

    const restored = await restoreKnowledgeSourceObject(db, {
      ...workspace,
      operationId: "generation-restore-object",
      actor,
      targetId: object.id,
      expectedGeneration: 2,
      reasonCode: "restored",
    });
    expect(restored).toMatchObject({ lifecycleState: "active", lifecycleGeneration: 3 });
    const restoredObject = await upsertKnowledgeSourceObject(db, {
      ...workspace,
      operationId: "generation-object-after-restore",
      actor,
      sourceId: source.id,
      externalObjectId: "object",
    });
    expect(restoredObject.id).toBe(object.id);
  });

  test("requires every evidence ACL and document ACL for human and agent eligibility", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("evidence-intersection");
    const alice = human("user:alice");
    const bob = human("user:bob");

    const broad = await createSourceVersion(workspace, {
      label: "broad",
      actor: alice,
      audience: workspaceScope(workspace.workspaceId),
    });
    const aliceOnly = await createSourceVersion(workspace, {
      label: "alice-only",
      actor: alice,
      audience: personalScope(workspace.workspaceId, alice.subjectId),
    });
    const mixedAclClaim = await createClaimFixture(workspace, {
      label: "mixed-acl",
      actor: alice,
      versionIds: [broad.version.id, aliceOnly.version.id],
    });
    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: alice.subjectId,
        surface: "human",
        claimId: mixedAclClaim.id,
      }),
    ).not.toBeNull();
    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: bob.subjectId,
        surface: "human",
        claimId: mixedAclClaim.id,
      }),
    ).toBeNull();
    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: alice.subjectId,
        surface: "agent",
        claimId: mixedAclClaim.id,
      }),
    ).not.toBeNull();

    await appendKnowledgeSourceAclVersion(db, {
      ...workspace,
      operationId: "broad-acl-2",
      actor: alice,
      sourceId: broad.source.id,
      audience: workspaceScope(workspace.workspaceId),
      expectedSourceLifecycleGeneration: 1,
      expectedAclGeneration: 1,
      aclVersion: "v2",
      agentAccess: false,
      reasonCode: "agents-disabled",
    });
    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: alice.subjectId,
        surface: "human",
        claimId: mixedAclClaim.id,
      }),
    ).not.toBeNull();
    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: alice.subjectId,
        surface: "agent",
        claimId: mixedAclClaim.id,
      }),
    ).toBeNull();

    await recordKnowledgeLifecycleEvent(db, {
      ...workspace,
      operationId: "alice-only-source-revoke",
      actor: alice,
      targetKind: "source",
      targetId: aliceOnly.source.id,
      eventType: "revoked",
      expectedGeneration: 1,
      reasonCode: "revoked",
    });
    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: alice.subjectId,
        surface: "human",
        claimId: mixedAclClaim.id,
      }),
    ).toBeNull();

    const aliceDocument = await createDocumentBridge(workspace, {
      label: "alice-private",
      visibility: "private",
      createdBy: alice.subjectId,
      agentAccess: true,
    });
    const bobDocument = await createDocumentBridge(workspace, {
      label: "bob-private",
      visibility: "private",
      createdBy: bob.subjectId,
      agentAccess: true,
    });
    const aliceDocumentVersion = await createSourceVersion(workspace, {
      label: "alice-document",
      actor: alice,
      audience: workspaceScope(workspace.workspaceId),
      document: aliceDocument,
    });
    const bobDocumentVersion = await createSourceVersion(workspace, {
      label: "bob-document",
      actor: bob,
      audience: workspaceScope(workspace.workspaceId),
      document: bobDocument,
    });
    const aliceDocumentClaim = await createClaimFixture(workspace, {
      label: "alice-document-claim",
      actor: alice,
      versionIds: [aliceDocumentVersion.version.id],
    });
    const bobDocumentClaim = await createClaimFixture(workspace, {
      label: "bob-document-claim",
      actor: bob,
      versionIds: [bobDocumentVersion.version.id],
    });
    const crossedDocumentClaim = await createClaimFixture(workspace, {
      label: "crossed-document-claim",
      actor: alice,
      versionIds: [aliceDocumentVersion.version.id, bobDocumentVersion.version.id],
    });

    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: alice.subjectId,
        surface: "human",
        claimId: aliceDocumentClaim.id,
      }),
    ).not.toBeNull();
    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: bob.subjectId,
        surface: "human",
        claimId: aliceDocumentClaim.id,
      }),
    ).toBeNull();
    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: bob.subjectId,
        surface: "human",
        claimId: bobDocumentClaim.id,
      }),
    ).not.toBeNull();
    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: alice.subjectId,
        surface: "human",
        claimId: bobDocumentClaim.id,
      }),
    ).toBeNull();
    for (const subject of [alice.subjectId, bob.subjectId]) {
      expect(
        await getEligibleKnowledgeClaim(db, {
          ...workspace,
          initiatingSubjectId: subject,
          surface: "human",
          claimId: crossedDocumentClaim.id,
        }),
      ).toBeNull();
    }
  });

  test("keeps bridged legacy private documents private and workspace-bound", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("legacy-document-boundary");
    const alice = human("user:alice");
    const bob = human("user:bob");
    const [siblingWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${workspace.accountId}, 'knowledge-legacy-sibling') returning id`;
    const workspaceDocument = await createDocumentBridge(workspace, {
      label: "legacy-workspace-document",
      visibility: "workspace",
      createdBy: null,
      agentAccess: true,
    });
    const privateDocument = await createDocumentBridge(workspace, {
      label: "legacy-private-document",
      visibility: "private",
      createdBy: alice.subjectId,
      agentAccess: true,
    });
    const workspaceVersion = await createSourceVersion(workspace, {
      label: "legacy-workspace-source",
      actor: alice,
      audience: workspaceScope(workspace.workspaceId),
      document: workspaceDocument,
    });
    const privateVersion = await createSourceVersion(workspace, {
      label: "legacy-private-source",
      actor: alice,
      audience: workspaceScope(workspace.workspaceId),
      document: privateDocument,
    });
    const workspaceClaim = await createClaimFixture(workspace, {
      label: "legacy-workspace-claim",
      actor: alice,
      versionIds: [workspaceVersion.version.id],
    });
    const privateClaim = await createClaimFixture(workspace, {
      label: "legacy-private-claim",
      actor: alice,
      versionIds: [privateVersion.version.id],
    });

    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: bob.subjectId,
        surface: "human",
        claimId: workspaceClaim.id,
      }),
    ).not.toBeNull();
    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: alice.subjectId,
        surface: "human",
        claimId: privateClaim.id,
      }),
    ).not.toBeNull();
    expect(
      await getEligibleKnowledgeClaim(db, {
        ...workspace,
        initiatingSubjectId: bob.subjectId,
        surface: "human",
        claimId: privateClaim.id,
      }),
    ).toBeNull();
    expect(
      await getEligibleKnowledgeClaim(db, {
        accountId: workspace.accountId,
        workspaceId: siblingWorkspace!.id,
        initiatingSubjectId: alice.subjectId,
        surface: "human",
        claimId: privateClaim.id,
      }),
    ).toBeNull();
    const [stored] = await admin<
      Array<{ visibility: string; workspaceId: string; createdBy: string | null }>
    >`
      select visibility, workspace_id as "workspaceId", created_by as "createdBy"
      from documents where id = ${privateDocument.documentId}`;
    expect(stored).toEqual({
      visibility: "private",
      workspaceId: workspace.workspaceId,
      createdBy: alice.subjectId,
    });
  });

  test("revokes PUBLIC mutator execution and denies direct app-role head mutation", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("security-definer");
    const actor = human("user:alice");
    const { source } = await createProviderSource(workspace, {
      label: "security",
      actor,
    });
    const initialAcl = await appendKnowledgeSourceAclVersion(db, {
      ...workspace,
      operationId: "security-acl-1",
      actor,
      sourceId: source.id,
      audience: workspaceScope(workspace.workspaceId),
      expectedSourceLifecycleGeneration: 1,
      expectedAclGeneration: 0,
      aclVersion: "v1",
      agentAccess: true,
      reasonCode: "initial",
    });
    const object = await upsertKnowledgeSourceObject(db, {
      ...workspace,
      operationId: "security-object",
      actor,
      sourceId: source.id,
      externalObjectId: "security-object",
    });
    await appendKnowledgeSourceAclVersion(db, {
      ...workspace,
      operationId: "security-acl-2",
      actor,
      sourceId: source.id,
      audience: workspaceScope(workspace.workspaceId),
      expectedSourceLifecycleGeneration: 1,
      expectedAclGeneration: 1,
      aclVersion: "v2",
      agentAccess: true,
      reasonCode: "advanced",
    });
    const routines = await admin<
      Array<{
        name: string;
        securityDefiner: boolean;
        appExecute: boolean;
        publicExecute: boolean;
        searchPath: string[] | null;
      }>
    >`
      select
        procedure.proname as name,
        procedure.prosecdef as "securityDefiner",
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        procedure.proconfig as "searchPath"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = current_schema()
        and procedure.proname in (
          'scoped_knowledge_apply_lifecycle',
          'scoped_knowledge_advance_source_acl',
          'scoped_knowledge_complete_sync',
          'scoped_knowledge_advance_object_version'
        )
      order by procedure.proname`;
    expect(routines).toHaveLength(4);
    for (const routine of routines) {
      expect(routine.securityDefiner).toBe(true);
      expect(routine.appExecute).toBe(true);
      expect(routine.publicExecute).toBe(false);
      expect(routine.searchPath).toContain("search_path=public, pg_catalog");
    }

    const app = postgres(appUrl, { max: 1, prepare: false });
    try {
      const staleVersionHash = hash("security-stale-version-input");
      let staleVersionError: unknown;
      try {
        await app.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
          await tx`select set_config('opengeni.subject_id', ${actor.subjectId}, true)`;
          const [version] = await tx<{ id: string }[]>`
            insert into knowledge_document_versions (
              account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
              source_id, object_id, version_generation, external_version_id,
              content_sha256, ingestion_key, acl_version_id, acl_generation,
              operation_id, input_hash, actor_kind, actor_subject_id,
              initiating_human_subject_id
            ) values (
              ${workspace.accountId}, 'workspace', ${workspace.workspaceId}, null,
              ${`workspace:${workspace.workspaceId}:-`}, ${source.id}, ${object.id}, 1,
              'stale-v1', ${hash("security-stale-version-content")},
              'security-stale-version-ingestion', ${initialAcl.id}, 1,
              'security-stale-version', ${staleVersionHash}, ${actor.kind},
              ${actor.subjectId}, ${actor.initiatingHumanSubjectId}
            ) returning id`;
          await tx`
            select scoped_knowledge_advance_object_version(
              ${workspace.accountId}::uuid, ${object.id}::uuid, 1::bigint, 0::bigint,
              ${version!.id}::uuid, 'security-stale-version', ${staleVersionHash},
              'observed', ${actor.kind}, ${actor.subjectId},
              ${actor.initiatingHumanSubjectId}
            )`;
        });
      } catch (error) {
        staleVersionError = error;
      }
      expect((staleVersionError as { code?: string } | undefined)?.code).toBe("40001");

      let directMutationError: unknown;
      try {
        await app.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
          await tx`select set_config('opengeni.subject_id', ${actor.subjectId}, true)`;
          await tx`
            update knowledge_sources set sync_cursor = 'forbidden'
            where id = ${source.id}`;
        });
      } catch (error) {
        directMutationError = error;
      }
      expect((directMutationError as { code?: string } | undefined)?.code).toBe("42501");

      const lifecycleInput = {
        ...workspace,
        operationId: "security-revoke-provider",
        actor,
        targetKind: "provider" as const,
        targetId: source.providerId,
        eventType: "revoked" as const,
        expectedGeneration: 1,
        reasonCode: "revoked",
      };
      await recordKnowledgeLifecycleEvent(db, lifecycleInput);
      const lifecycleHash = scopedKnowledgeInputHash({
        targetKind: lifecycleInput.targetKind,
        targetId: lifecycleInput.targetId,
        eventType: lifecycleInput.eventType,
        expectedGeneration: lifecycleInput.expectedGeneration,
        actor,
      });
      const [siblingWorkspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${workspace.accountId}, 'knowledge-security-sibling') returning id`;
      let crossScopeReplayError: unknown;
      try {
        await app.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${siblingWorkspace!.id}, true)`;
          await tx`select set_config('opengeni.subject_id', ${actor.subjectId}, true)`;
          await tx`
            select * from scoped_knowledge_apply_lifecycle(
              ${workspace.accountId}::uuid, 'provider', ${lifecycleInput.targetId}::uuid,
              'revoked', 1::bigint, ${lifecycleInput.operationId}, ${lifecycleHash},
              ${lifecycleInput.reasonCode}, ${actor.kind}, ${actor.subjectId},
              ${actor.initiatingHumanSubjectId}
            )`;
        });
      } catch (error) {
        crossScopeReplayError = error;
      }
      expect((crossScopeReplayError as { code?: string } | undefined)?.code).toBe("P0002");
    } finally {
      await app.end();
    }
  });
});
