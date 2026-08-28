import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  SiteConflictError,
  SiteIdempotencyError,
  SiteNotFoundError,
  archiveSite,
  bootstrapWorkspace,
  createDb,
  createWorkspaceArtifact,
  deleteWorkspace,
  getSite,
  listSites,
  publishSite,
  rollbackSite,
  type DbClient,
} from "../src";

const migrationUrl = new URL("../drizzle/0374_workspace_sites.sql", import.meta.url);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let available = true;
let first: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];
let second: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

const manifest = {
  schemaVersion: 1 as const,
  ai: {
    enabled: true,
    defaultModel: "gpt-5.6",
    allowedModels: ["gpt-5.6"],
    reasoningEffort: "medium" as const,
    instructions: "Use only approved local workspace knowledge.",
    monthlyBudgetMicros: null,
  },
  integrations: {
    firstPartyPermissions: ["workspace:read", "documents:search", "connections:read"],
    firstPartyTools: ["memory_search"],
    mcpServers: [],
    allowedPersonalConnectionServerIds: [],
  },
  approvals: { writeActions: "platform_prompt" as const },
  access: { audience: "workspace" as const },
};

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-sites");
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("database unavailable");
    return;
  }
  client = createDb(shared.appUrl);
  first = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `sites-${crypto.randomUUID()}`,
      accountName: "Sites",
      workspaceExternalSource: "test",
      workspaceExternalId: `sites-${crypto.randomUUID()}`,
      workspaceName: "Sites",
      subjectId: "user:sites-owner",
    })
  ).workspaceGrants[0]!;
  second = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `sites-foreign-${crypto.randomUUID()}`,
      accountName: "Foreign Sites",
      workspaceExternalSource: "test",
      workspaceExternalId: `sites-foreign-${crypto.randomUUID()}`,
      workspaceName: "Foreign Sites",
      subjectId: "user:foreign-sites-owner",
    })
  ).workspaceGrants[0]!;
}, 180_000);

afterAll(async () => {
  if (client && first?.workspaceId)
    await deleteWorkspace(client.db, first.workspaceId).catch(() => undefined);
  if (client && second?.workspaceId)
    await deleteWorkspace(client.db, second.workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

describe("Sites migration", () => {
  test("installs FORCE-RLS state with append-only release, event, and runtime evidence", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("FOREACH table_name IN ARRAY");
    expect(source).toContain("opengeni_private.workspace_rls_visible(account_id, workspace_id)");
    expect(source).toContain(
      'FOREIGN KEY ("workspace_id", "session_id")\n    REFERENCES "sessions"("workspace_id", "id")',
    );
    expect(source).toContain(
      'FOREIGN KEY ("session_id", "account_id")\n    REFERENCES "sessions"("id", "account_id")',
    );
    for (const table of [
      "workspace_site_releases",
      "workspace_site_events",
      "workspace_site_runtime_sessions",
    ]) {
      expect(source).toContain(`CREATE POLICY "workspace_select" ON "${table}" FOR SELECT`);
      expect(source).toContain(`CREATE POLICY "workspace_insert" ON "${table}" FOR INSERT`);
      expect(source).not.toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}"`);
    }
  });
});

describe("Sites persistence", () => {
  test("publishes immutable manifests idempotently, CAS-rolls back, and isolates workspaces", async () => {
    if (!available || !client) return;
    const artifactId = crypto.randomUUID();
    const html = "<!doctype html><title>SINTEF local data</title>";
    const artifact = await createWorkspaceArtifact(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      artifactId,
      slug: "sintef-local-data",
      title: "SINTEF Local Data",
      description: "Local governed research data",
      contentKey: `test/${artifactId}.html`,
      contentSha256: createHash("sha256").update(html).digest("hex"),
      sizeBytes: Buffer.byteLength(html),
      operationKey: crypto.randomUUID(),
      actorSubjectId: first.subjectId,
      sourceSessionId: null,
      sourceTurnId: null,
      sourceAttemptId: null,
      sourceExecutionGeneration: null,
      sourceToolName: null,
      persistContent: async () => undefined,
    });
    const operationId = crypto.randomUUID();
    const request = {
      operationId,
      expectedCurrentReleaseId: null,
      artifactVersionId: artifact.version.id,
      manifest,
      reason: "Initial Site release",
    };
    const created = await publishSite(client.db, {
      workspaceId: first.workspaceId,
      actorSubjectId: first.subjectId,
      request,
    });
    expect(created.site.id).toBe(artifactId);
    expect(created.site.runtimeKind).toBe("static_spa");
    expect(created.release.revision).toBe(1);
    expect((await listSites(client.db, first.workspaceId)).map((site) => site.id)).toContain(
      artifactId,
    );
    expect(
      (
        await publishSite(client.db, {
          workspaceId: first.workspaceId,
          actorSubjectId: first.subjectId,
          request,
        })
      ).release.id,
    ).toBe(created.release.id);
    await expect(
      publishSite(client.db, {
        workspaceId: first.workspaceId,
        actorSubjectId: first.subjectId,
        request: { ...request, reason: "different" },
      }),
    ).rejects.toBeInstanceOf(SiteIdempotencyError);
    await expect(
      publishSite(client.db, {
        workspaceId: first.workspaceId,
        actorSubjectId: first.subjectId,
        request: { ...request, operationId: crypto.randomUUID() },
      }),
    ).rejects.toBeInstanceOf(SiteConflictError);
    const rolled = await rollbackSite(client.db, {
      workspaceId: first.workspaceId,
      siteId: artifactId,
      actorSubjectId: first.subjectId,
      request: {
        operationId: crypto.randomUUID(),
        expectedCurrentReleaseId: created.release.id,
        releaseId: created.release.id,
        reason: "Rollback exercises a new immutable release",
      },
    });
    expect(rolled.release.revision).toBe(2);
    expect((await getSite(client.db, first.workspaceId, artifactId)).events[0]?.type).toBe(
      "rolled_back",
    );
    const archiveRequest = {
      operationId: crypto.randomUUID(),
      expectedCurrentReleaseId: rolled.release.id,
      reason: "End the reference demonstration",
    };
    const archived = await archiveSite(client.db, {
      workspaceId: first.workspaceId,
      siteId: artifactId,
      actorSubjectId: first.subjectId,
      request: archiveRequest,
    });
    expect(archived.site.status).toBe("archived");
    expect(
      (
        await archiveSite(client.db, {
          workspaceId: first.workspaceId,
          siteId: artifactId,
          actorSubjectId: first.subjectId,
          request: archiveRequest,
        })
      ).site.status,
    ).toBe("archived");
    await expect(
      publishSite(client.db, {
        workspaceId: first.workspaceId,
        actorSubjectId: first.subjectId,
        request: {
          ...request,
          operationId: crypto.randomUUID(),
          expectedCurrentReleaseId: rolled.release.id,
        },
      }),
    ).rejects.toThrow("Archived Sites cannot be published");
    await expect(getSite(client.db, second.workspaceId, artifactId)).rejects.toBeInstanceOf(
      SiteNotFoundError,
    );
  }, 180_000);
});
