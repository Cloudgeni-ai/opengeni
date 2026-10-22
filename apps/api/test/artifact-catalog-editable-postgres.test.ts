import { afterAll, beforeAll, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  EditableArtifactApplication,
  EditableArtifactService,
  InMemoryEditableArtifactStableIdFactory,
  editableArtifactReplicaId,
  editableArtifactId,
  editableArtifactStorePortFromPostgres,
  ogatxEditableArtifactMutationIntentCodec,
} from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  PostgresEditableArtifactStore,
  withDatabaseTimingObserver,
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
import { registerArtifactCatalogRoutes } from "../src/routes/artifact-catalog";

let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("catalog-editable-batch");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl, { searchPath: shared.schema, max: 8 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("catalog retains live artifact authorization while batching metadata transactions", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "catalog-batch-test",
    accountExternalId: suffix,
    accountName: "Catalog batch",
    workspaceExternalSource: "catalog-batch-test",
    workspaceExternalId: suffix,
    workspaceName: "Catalog batch",
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
  const authorization = new PostgresEditableArtifactAuthorization(client.db);
  const domain = new EditableArtifactService({
    store: editableArtifactStorePortFromPostgres(store),
    authorization,
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
  const expectedIds: string[] = [];
  for (let index = 0; index < 20; index++) {
    const artifact = await application.createArtifact({
      scope,
      actor,
      idempotencyKey: `catalog:${suffix}:${index}` as never,
      modality: "document",
      title: `Report ${index.toString().padStart(2, "0")}`,
    });
    expectedIds.push(artifact.id);
  }
  const secret = "catalog-editable-batch-test-secret";
  const app = new Hono(),
    legacyApp = new Hono();
  const deps = {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
    managedAuth: null,
    editableArtifacts: application,
  };
  registerArtifactCatalogRoutes(app, deps as never);
  registerArtifactCatalogRoutes(legacyApp, {
    ...deps,
    editableArtifacts: { readArtifact: application.readArtifact.bind(application) },
  } as never);
  const token = await signDelegatedAccessToken(secret, {
    ...scope,
    subjectId: grant.subjectId,
    principalKind: "human_session",
    permissions: ["artifacts:read"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const authorize = authorization.authorize.bind(authorization);
  let authorizations = 0;
  authorization.authorize = async (input) => {
    authorizations++;
    return authorize(input);
  };
  let transactions = 0;
  const start = performance.now();
  const response = await withDatabaseTimingObserver(
    (observation) => {
      if (observation.stage === "transaction_admission") transactions++;
    },
    () =>
      app.request(
        `/v1/workspaces/${scope.workspaceId}/artifact-catalog?kind=document&sort=title&limit=20`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      ),
  );
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.items.map((item: { id: string }) => item.id)).toEqual(expectedIds);
  expect(body.nextCursor).toBeNull();
  expect(authorizations).toBe(20);
  // One candidate scan, twenty unchanged live authorization transactions,
  // and three metadata reads (8 + 8 + 4), rather than one per item.
  expect(transactions).toBe(24);
  console.info(
    "catalog-editable-work",
    JSON.stringify({ authorizations, transactions, durationMs: performance.now() - start }),
  );
  let legacyTransactions = 0;
  authorizations = 0;
  const legacyStart = performance.now();
  const legacyResponse = await withDatabaseTimingObserver(
    (observation) => {
      if (observation.stage === "transaction_admission") legacyTransactions++;
    },
    () =>
      legacyApp.request(
        `/v1/workspaces/${scope.workspaceId}/artifact-catalog?kind=document&sort=title&limit=20`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      ),
  );
  expect(legacyResponse.status).toBe(200);
  expect(await legacyResponse.json()).toEqual(body);
  expect(authorizations).toBe(20);
  expect(legacyTransactions).toBe(41);
  console.info(
    "catalog-editable-scalar-work",
    JSON.stringify({
      authorizations,
      transactions: legacyTransactions,
      durationMs: performance.now() - legacyStart,
    }),
  );
  const artifactId = editableArtifactId(expectedIds[0]!);
  const scalar = await application.readArtifact({ scope, actor, artifactId });
  const missingId = "f".repeat(32);
  expect(
    await store.readArtifactsAtAuthorizationRevisions(scope, [
      { artifactId: missingId, expectedAuthorizationRevision: scalar.authorizationRevision },
      { artifactId, expectedAuthorizationRevision: scalar.authorizationRevision + 1 },
      { artifactId, expectedAuthorizationRevision: scalar.authorizationRevision },
    ]),
  ).toEqual([
    { status: "fulfilled", value: { kind: "result", artifact: null } },
    { status: "fulfilled", value: { kind: "authorization_stale" } },
    { status: "fulfilled", value: { kind: "result", artifact: scalar } },
  ]);
  expect(
    await store.readArtifactsAtAuthorizationRevisions(
      { ...scope, accountId: crypto.randomUUID() },
      [{ artifactId, expectedAuthorizationRevision: scalar.authorizationRevision }],
    ),
  ).toEqual([{ status: "fulfilled", value: { kind: "result", artifact: null } }]);
  expect(
    await domain.getArtifacts({
      scope,
      actor: { ...actor, subjectId: "user:outside" },
      artifactIds: [artifactId],
    }),
  ).toMatchObject([{ status: "rejected", reason: { code: "forbidden" } }]);
  const otherModalities = [];
  for (const modality of ["spreadsheet", "presentation"] as const) {
    otherModalities.push(
      await application.createArtifact({
        scope,
        actor,
        modality,
        title: `Catalog ${modality}`,
        idempotencyKey: `catalog:${suffix}:${modality}` as never,
      }),
    );
  }
  expect(
    await store.readArtifactsAtAuthorizationRevisions(
      scope,
      otherModalities.map((artifact) => ({
        artifactId: artifact.id,
        expectedAuthorizationRevision: artifact.authorizationRevision,
      })),
    ),
  ).toEqual(
    otherModalities.map((artifact) => ({
      status: "fulfilled",
      value: { kind: "result", artifact },
    })),
  );
}, 60_000);
