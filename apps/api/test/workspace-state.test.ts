import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  signDelegatedAccessToken,
  WORKSPACE_STATE_MAX_BASES,
  WorkspaceStateResponse,
  type Permission,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  completeFileUpload,
  createDb,
  createFileUpload,
  deleteWorkspace,
  updateWorkspace,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import {
  addDocumentToBase,
  createDocumentBase,
  getDocumentInventory,
  listDocumentBases,
} from "@opengeni/documents";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";

import { registerWorkspaceStateRoutes } from "../src/routes/workspace-state";

const DELEGATION_SIGNING_FIXTURE = ["workspace", "state", "test", "signing", "fixture"].join("-");

type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let grant: Grant;

beforeAll(async () => {
  const explicitAdminUrl = process.env.OPENGENI_WORKSPACE_STATE_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_WORKSPACE_STATE_TEST_APP_URL;
  if (explicitAdminUrl && explicitAppUrl) {
    const explicitAppPassword = decodeURIComponent(new URL(explicitAppUrl).password);
    await migrate(explicitAdminUrl);
    await provisionRoles(explicitAdminUrl, { appPassword: explicitAppPassword });
    const admin = postgres(explicitAdminUrl, { max: 4, prepare: false });
    shared = {
      admin,
      adminUrl: explicitAdminUrl,
      appUrl: explicitAppUrl,
      release: async () => {
        await admin.end();
      },
    };
  } else {
    const acquired = await acquireSharedTestDatabase("workspace-state");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
  }
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `workspace-state-account-${crypto.randomUUID()}`,
    accountName: "Workspace State account",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-state-workspace-${crypto.randomUUID()}`,
    workspaceName: "Workspace State workspace",
    subjectId: "user:workspace-state-reader",
  });
  grant = access.workspaceGrants[0]!;
  await updateWorkspace(client.db, grant.workspaceId, {
    agentInstructions: "PRIVATE LEGACY WORKSPACE INSTRUCTIONS",
  });
  app = new Hono();
  registerWorkspaceStateRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SIGNING_FIXTURE,
    }),
    db: client.db,
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (client && grant) await deleteWorkspace(client.db, grant.workspaceId);
  await client?.close();
  await shared?.release();
}, 60_000);

async function request(permissions: Permission[]): Promise<Response> {
  const bearer = await signDelegatedAccessToken(DELEGATION_SIGNING_FIXTURE, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  const headers = new Headers();
  headers.set("authorization", ["Bearer", bearer].join(" "));
  return await app.request(`http://x/v1/workspaces/${grant.workspaceId}/workspace-state`, {
    headers,
  });
}

async function readyFile(name: string, targetGrant = grant): Promise<string> {
  const fileId = crypto.randomUUID();
  const upload = await createFileUpload(client.db, {
    accountId: targetGrant.accountId,
    workspaceId: targetGrant.workspaceId,
    fileId,
    filename: `${name}.txt`,
    safeFilename: `${name}.txt`,
    contentType: "text/plain",
    sizeBytes: 1,
    sha256: "a".repeat(64),
    bucket: "workspace-state-test",
    objectKey: `workspace-state/${fileId}.txt`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await completeFileUpload(client.db, targetGrant.workspaceId, upload.uploadId);
  return fileId;
}

describe("workspace state API authorization", () => {
  test("requires workspace read and withholds all knowledge facts without document search", async () => {
    const denied = await request(["documents:search"]);
    expect(denied.status).toBe(403);

    const metadataOnly = await request(["workspace:read"]);
    expect(metadataOnly.status).toBe(200);
    expect(metadataOnly.headers.get("cache-control")).toBe("private, no-store");
    const body = WorkspaceStateResponse.parse(await metadataOnly.json());
    expect(body.knowledge).toEqual({
      availability: "unavailable",
      reason: "missing_permission",
      requiredPermission: "documents:search",
    });
    expect(body.policy.legacyRuntime).toEqual({
      source: "workspace_override",
      workspaceOverrideConfigured: true,
    });
    expect(JSON.stringify(body)).not.toContain("PRIVATE LEGACY WORKSPACE INSTRUCTIONS");
  });

  test("returns an empty visible inventory only with document search permission", async () => {
    const response = await request(["workspace:read", "documents:search"]);
    expect(response.status).toBe(200);
    const body = WorkspaceStateResponse.parse(await response.json());
    expect(body.knowledge.availability).toBe("available");
    if (body.knowledge.availability !== "available") throw new Error("expected inventory");
    expect(body.knowledge).toMatchObject({
      baseCount: 0,
      inspectedVisibleDocumentCount: 0,
      gaps: [
        { code: "no_document_bases", relatedCount: 0 },
        { code: "no_memory_records", relatedCount: 0 },
      ],
    });
  });

  test("bounds base rows while aggregating all and only subject-visible documents", async () => {
    for (let index = 0; index < WORKSPACE_STATE_MAX_BASES + 1; index += 1) {
      await createDocumentBase(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        name: `Inventory base ${String(index).padStart(2, "0")}`,
      });
    }
    const targetBase = (await listDocumentBases(client.db, grant.workspaceId))[0]!;
    await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("workspace-visible"),
      title: "workspace visible",
      sourceKind: "repository",
      visibility: "workspace",
      createdBy: grant.subjectId,
    });
    await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("owner-private"),
      title: "owner private",
      sourceKind: "email",
      visibility: "private",
      createdBy: grant.subjectId,
    });
    await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("other-private"),
      title: "other private",
      sourceKind: "chat",
      visibility: "private",
      createdBy: "user:another-subject",
    });

    const response = await request(["workspace:read", "documents:search"]);
    expect(response.status).toBe(200);
    const body = WorkspaceStateResponse.parse(await response.json());
    expect(body.knowledge.availability).toBe("available");
    if (body.knowledge.availability !== "available") throw new Error("expected inventory");
    expect(body.knowledge).toMatchObject({
      coverage: "partial",
      baseCount: WORKSPACE_STATE_MAX_BASES + 1,
      basesTruncated: true,
      inspectedVisibleDocumentCount: 2,
      documentStatusCounts: { queued: 2, indexing: 0, ready: 0, failed: 0 },
      sourceKindCounts: { repository: 1, email: 1, chat: 0 },
    });
    expect(body.knowledge.bases).toHaveLength(WORKSPACE_STATE_MAX_BASES);
    expect(body.knowledge.bases.find((base) => base.id === targetBase.id)).toMatchObject({
      visibleDocumentCount: 2,
      statusCounts: { queued: 2, indexing: 0, ready: 0, failed: 0 },
    });
    expect(body.knowledge.gaps).toContainEqual({
      code: "processing_documents",
      severity: "info",
      relatedCount: 2,
    });
    expect(body.knowledge.gaps).toContainEqual({
      code: "partial_inventory",
      severity: "info",
      relatedCount: null,
    });
  });

  test("NFKC-normalizes topic coverage per document under FORCE RLS", async () => {
    const [posture] = await shared.admin<
      Array<{ rowSecurity: boolean; forceRowSecurity: boolean }>
    >`
      select relrowsecurity as "rowSecurity", relforcerowsecurity as "forceRowSecurity"
      from pg_class
      where oid = 'documents'::regclass
    `;
    expect(posture).toEqual({ rowSecurity: true, forceRowSecurity: true });

    const targetBase = (await listDocumentBases(client.db, grant.workspaceId))[0]!;
    const malformedOnly = await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("malformed-only-topics"),
      title: "malformed only topics",
      visibility: "workspace",
      createdBy: grant.subjectId,
    });
    const mixed = await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("mixed-topics"),
      title: "mixed topics",
      visibility: "workspace",
      createdBy: grant.subjectId,
    });
    const normalizedEmptyOnly = await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("normalized-empty-only-topics"),
      title: "normalized empty only topics",
      visibility: "workspace",
      createdBy: grant.subjectId,
    });
    const hiddenPrivate = await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("hidden-private-topics"),
      title: "hidden private topics",
      visibility: "private",
      createdBy: "user:another-subject",
    });
    const malformedTopics: unknown[] = [{ label: "object-label" }, true, 7, ["nested-label"], null];
    await shared.admin`
      update documents
      set status = 'ready', topics = ${shared.admin.json(malformedTopics)}::jsonb,
          updated_at = now()
      where id in (${malformedOnly.id}, ${mixed.id})
    `;
    await shared.admin`
      update documents
      set status = 'ready', topics = ${shared.admin.json([
        "\u00a0",
        "\u2007",
        "\u202f",
        "\u3000",
        "\t\r\n",
      ])}::jsonb, updated_at = now()
      where id = ${normalizedEmptyOnly.id}
    `;
    await shared.admin`
      update documents
      set status = 'ready', topics = ${shared.admin.json(["private-hidden"])}::jsonb,
          updated_at = now()
      where id = ${hiddenPrivate.id}
    `;

    const malformedInventory = await getDocumentInventory(client.db, grant.workspaceId, {
      baseLimit: WORKSPACE_STATE_MAX_BASES,
      topicLimit: 20,
      topicMaxChars: 120,
      access: { viewerSubjectId: grant.subjectId },
    });
    expect(malformedInventory.topics).toEqual([]);
    expect(malformedInventory.statusCounts.ready).toBe(3);

    const malformedResponse = await request(["workspace:read", "documents:search"]);
    expect(malformedResponse.status).toBe(200);
    const malformedBody = WorkspaceStateResponse.parse(await malformedResponse.json());
    expect(malformedBody.knowledge.availability).toBe("available");
    if (malformedBody.knowledge.availability !== "available") {
      throw new Error("expected inventory");
    }
    expect(malformedBody.knowledge.topics).toEqual([]);
    expect(malformedBody.knowledge.documentStatusCounts.ready).toBe(3);
    expect(malformedBody.knowledge.gaps).toContainEqual({
      code: "missing_topic_coverage",
      severity: "info",
      relatedCount: 3,
    });

    const distinctVisible = await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("distinct-normalized-topics"),
      title: "distinct normalized topics",
      visibility: "workspace",
      createdBy: grant.subjectId,
    });
    const ownerPrivate = await addDocumentToBase(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: targetBase.id,
      fileId: await readyFile("owner-private-normalized-topics"),
      title: "owner private normalized topics",
      visibility: "private",
      createdBy: grant.subjectId,
    });
    const otherAccess = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `workspace-state-other-account-${crypto.randomUUID()}`,
      accountName: "Workspace State other account",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-state-other-workspace-${crypto.randomUUID()}`,
      workspaceName: "Workspace State other workspace",
      subjectId: "user:workspace-state-other-reader",
    });
    const otherGrant = otherAccess.workspaceGrants[0]!;
    const otherBase = await createDocumentBase(client.db, {
      accountId: otherGrant.accountId,
      workspaceId: otherGrant.workspaceId,
      name: "Other tenant base",
    });
    const otherTenant = await addDocumentToBase(client.db, {
      accountId: otherGrant.accountId,
      workspaceId: otherGrant.workspaceId,
      baseId: otherBase.id,
      fileId: await readyFile("other-tenant-normalized-topics", otherGrant),
      title: "other tenant normalized topics",
      visibility: "workspace",
      createdBy: otherGrant.subjectId,
    });

    const mixedTopics: unknown[] = [
      "  Incident   Response  ",
      "Incident Response",
      "AI",
      "ＡＩ",
      "Security",
      "Ｓｅｃｕｒｉｔｙ",
      "valid",
      "",
      "   ",
      { label: "object-label" },
      false,
      42,
      ["nested-label"],
      null,
    ];
    await shared.admin`
      update documents
      set topics = ${shared.admin.json(mixedTopics)}::jsonb, updated_at = now()
      where id = ${mixed.id}
    `;
    await shared.admin`
      update documents
      set status = 'ready', topics = ${shared.admin.json(["ＡＩ", "Security", "Beta"])}::jsonb,
          updated_at = now()
      where id = ${distinctVisible.id}
    `;
    await shared.admin`
      update documents
      set status = 'ready', topics = ${shared.admin.json(["Security", "Beta"])}::jsonb,
          updated_at = now()
      where id = ${ownerPrivate.id}
    `;
    await shared.admin`
      update documents
      set topics = ${shared.admin.json(["AI", "Security", "Beta", "private-hidden"])}::jsonb,
          updated_at = now()
      where id = ${hiddenPrivate.id}
    `;
    await shared.admin`
      update documents
      set status = 'ready', topics = ${shared.admin.json([
        "AI",
        "Security",
        "cross-tenant",
      ])}::jsonb,
          updated_at = now()
      where id = ${otherTenant.id}
    `;

    const mixedResponse = await request(["workspace:read", "documents:search"]);
    expect(mixedResponse.status).toBe(200);
    const mixedBody = WorkspaceStateResponse.parse(await mixedResponse.json());
    expect(mixedBody.knowledge.availability).toBe("available");
    if (mixedBody.knowledge.availability !== "available") throw new Error("expected inventory");
    expect(mixedBody.knowledge.topics).toEqual([
      { name: "Security", documentCount: 3 },
      { name: "AI", documentCount: 2 },
      { name: "Beta", documentCount: 2 },
      { name: "Incident Response", documentCount: 1 },
      { name: "valid", documentCount: 1 },
    ]);
    expect(mixedBody.knowledge.documentStatusCounts.ready).toBe(5);
    expect(mixedBody.knowledge.gaps.map((gap) => gap.code)).not.toContain("missing_topic_coverage");
    const topicLabels = JSON.stringify(mixedBody.knowledge.topics);
    expect(topicLabels).not.toContain("private-hidden");
    expect(topicLabels).not.toContain("cross-tenant");
    expect(topicLabels).not.toContain("object-label");
    expect(topicLabels).not.toContain("nested-label");
    expect(topicLabels).not.toContain("false");
    expect(topicLabels).not.toContain("42");
    expect(topicLabels).not.toContain("null");
  });
});
