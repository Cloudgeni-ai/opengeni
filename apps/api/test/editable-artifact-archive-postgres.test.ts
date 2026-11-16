import { afterAll, beforeAll, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  EditableArtifactApplication,
  EditableArtifactService,
  InMemoryEditableArtifactStableIdFactory,
  editableArtifactReplicaId,
  editableArtifactStorePortFromPostgres,
  ogatxEditableArtifactMutationIntentCodec,
} from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  listEditableArtifactIdsForSession,
  touchEditableArtifactSessionLink,
  withSessionRlsActorContext,
  listArtifactCatalogCandidates,
  PostgresEditableArtifactStore,
  type DbClient,
} from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import {
  TestAuthoritativeKernel,
  TestArtifactGenesis,
  TestArtifactSnapshotVerifier,
} from "../../../packages/core/test/editable-artifacts/fixtures";
import { PostgresEditableArtifactAuthorization } from "../src/editable-artifact-production";
import { registerEditableArtifactRoutes } from "../src/routes/editable-artifacts";

let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("editable-artifact-archive");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl, { searchPath: shared.schema, max: 4 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("archiving removes a presentation from Artifacts, is idempotent and needs the artifact's managers", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "archive-test",
    accountExternalId: suffix,
    accountName: "Archive",
    workspaceExternalSource: "archive-test",
    workspaceExternalId: suffix,
    workspaceName: "Archive",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const actor = {
    kind: "human" as const,
    subjectId: grant.subjectId,
    replicaId: editableArtifactReplicaId("aaaaaaaaaaaaaaaa"),
  };
  const store = new PostgresEditableArtifactStore(client.db);
  const domain = new EditableArtifactService({
    store: editableArtifactStorePortFromPostgres(store),
    authorization: new PostgresEditableArtifactAuthorization(client.db),
    kernel: new TestAuthoritativeKernel(),
    intentCodec: ogatxEditableArtifactMutationIntentCodec,
    snapshotVerifier: new TestArtifactSnapshotVerifier(),
    genesis: new TestArtifactGenesis(),
    ids: new InMemoryEditableArtifactStableIdFactory(1n),
    clock: { now: () => new Date() },
  });
  const application = new EditableArtifactApplication({
    domain,
    live: {} as never,
    compatibility: {} as never,
  });
  const artifact = await application.createArtifact({
    scope,
    actor,
    idempotencyKey: `archive:${suffix}` as never,
    modality: "presentation",
    title: "Disposable deck",
  });
  const source = await createSession(client.db, {
    ...scope,
    initialMessage: "Archive fixture",
    resources: [],
    metadata: {},
    model: "fixture",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    createdByContext: {},
  });
  await withSessionRlsActorContext({ subjectId: grant.subjectId }, () =>
    touchEditableArtifactSessionLink(client.db, scope, source.id, artifact.id),
  );
  const sessionArtifacts = async () =>
    await withSessionRlsActorContext({ subjectId: grant.subjectId }, () =>
      listEditableArtifactIdsForSession(client.db, scope, source.id, 64),
    );
  expect(await sessionArtifacts()).toEqual([artifact.id]);
  const secret = "editable-artifact-archive-test-secret";
  const app = new Hono();
  registerEditableArtifactRoutes(app, {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
    managedAuth: null,
    editableArtifacts: application,
  } as never);
  const token = async (subjectId: string, permissions: string[]) =>
    await signDelegatedAccessToken(secret, {
      ...scope,
      subjectId,
      principalKind: "human_session",
      permissions: permissions as never,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  const archive = async (bearer: string, artifactId = artifact.id) =>
    await app.request(
      `/v1/workspaces/${scope.workspaceId}/editable-artifacts/${artifactId}/archive`,
      { method: "POST", headers: { authorization: `Bearer ${bearer}` } },
    );
  const lifecycle = async () =>
    (await application.readArtifact({ scope, actor, artifactId: artifact.id })).lifecycle;

  // Reading alone is not enough to archive.
  const reader = await archive(await token(grant.subjectId, ["artifacts:read"]));
  expect(reader.status).toBe(403);
  // Someone outside the workspace is refused by the artifact's own authorization.
  const outsider = await archive(
    await token("user:outside", ["artifacts:read", "artifacts:publish"]),
  );
  expect(outsider.status).toBe(403);
  expect(await lifecycle()).toBe("active");

  const manager = await token(grant.subjectId, ["artifacts:read", "artifacts:publish"]);
  const first = await archive(manager);
  const body = await first.json();
  expect(first.status, JSON.stringify(body)).toBe(200);
  expect(body).toMatchObject({ id: artifact.id, lifecycle: "archived" });
  expect(await lifecycle()).toBe("archived");
  // Archiving again returns it unchanged.
  const again = await archive(manager);
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ id: artifact.id, lifecycle: "archived" });
  // An unknown artifact reads as missing.
  expect((await archive(manager, "f".repeat(32))).status).toBe(404);

  // It is removed: it no longer opens and leaves the Artifacts list.
  await expect(
    application.mintLiveTicket({
      scope,
      actor,
      artifactId: artifact.id,
      modality: "presentation",
      liveProtocolVersion: 1,
      kernelVersion: "test",
      modelSchemaVersion: 1,
      snapshotVersion: 1,
      commandProtocolVersion: 1,
      committedTransactionProtocolVersion: 1,
      allowEdit: true,
    } as never),
  ).rejects.toMatchObject({ code: "not_found" });
  const listed = async (status: "active" | "archived") =>
    (
      await listArtifactCatalogCandidates(client.db, scope, {
        query: { kind: "presentation", sort: "updated", status, limit: 20 },
        kinds: ["presentation"],
        siteViewer: { subjectId: grant.subjectId },
        snapshotAt: new Date(Date.now() + 1000).toISOString(),
        limit: 20,
      })
    ).map((item) => item.id);
  expect(await listed("active")).not.toContain(artifact.id);
  expect(await listed("archived")).not.toContain(artifact.id);
  // The chat's artifact panel drops it too.
  expect(await sessionArtifacts()).toEqual([]);
}, 60_000);
