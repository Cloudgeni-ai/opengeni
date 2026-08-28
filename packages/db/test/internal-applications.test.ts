import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import {
  bootstrapWorkspace,
  beginInternalApplicationApply,
  beginInternalApplicationSimpleOperation,
  createDb,
  createInternalApplication,
  deleteWorkspace,
  getInternalApplication,
  InternalApplicationIdempotencyError,
  InternalApplicationNotFoundError,
  InternalApplicationVersionConflictError,
  listInternalApplicationBundles,
  listInternalApplicationDataSources,
  listInternalApplicationDeploymentOperations,
  listInternalApplicationDeployments,
  listInternalApplicationEvents,
  persistInternalApplicationDeploymentPlan,
  registerInternalApplicationBundle,
  recordInternalApplicationBuildSessionStarted,
  reconcileInternalApplicationUnknownOperation,
  settleInternalApplicationApply,
  settleInternalApplicationSimpleOperation,
  updateInternalApplication,
  upsertInternalApplicationDataSource,
  upsertInternalApplicationDeploymentTarget,
  type DbClient,
} from "../src";

const migrationUrl = new URL("../drizzle/0373_internal_applications.sql", import.meta.url);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let available = true;
let first: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];
let second: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("internal-applications");
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("database unavailable");
    return;
  }
  client = createDb(shared.appUrl);
  first = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `internal-apps-${crypto.randomUUID()}`,
      accountName: "Internal applications",
      workspaceExternalSource: "test",
      workspaceExternalId: `internal-apps-${crypto.randomUUID()}`,
      workspaceName: "Internal applications",
      subjectId: "user:internal-app-owner",
    })
  ).workspaceGrants[0]!;
  second = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `foreign-${crypto.randomUUID()}`,
      accountName: "Foreign",
      workspaceExternalSource: "test",
      workspaceExternalId: `foreign-${crypto.randomUUID()}`,
      workspaceName: "Foreign",
      subjectId: "user:foreign-owner",
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

const definition = {
  schemaVersion: 1 as const,
  source: {
    kind: "prompt" as const,
    prompt: "Build a local maintenance assistant.",
  },
  dataBindings: [],
  compute: {
    architecture: "amd64" as const,
    cpuMillicores: 500,
    memoryMiB: 1024,
    storageMiB: 2048,
    gpu: null,
    minReplicas: 1,
    maxReplicas: 2,
  },
  ai: {
    enabled: true,
    route: "local" as const,
    defaultModel: "local-research-model",
    allowedModels: ["local-research-model"],
    capabilities: ["document-search"],
    monthlyBudgetMicros: null,
    requireHumanApprovalForWrites: true,
  },
  routes: [{ name: "web", path: "/", port: 3000, visibility: "workspace" as const }],
  variableSetIds: [],
  metadata: { ownerTeam: "research" },
};

describe("internal application migration", () => {
  test("installs only tenant-fenced tables and immutable evidence policies", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(1);
    expect(source).toContain("FOREACH table_name IN ARRAY");
    expect(source).toContain("opengeni_private.workspace_rls_visible(account_id, workspace_id)");
    for (const table of [
      "internal_application_revisions",
      "internal_application_bundles",
      "internal_application_events",
    ]) {
      expect(source).toContain(`CREATE POLICY "workspace_select" ON "${table}" FOR SELECT`);
      expect(source).toContain(`CREATE POLICY "workspace_insert" ON "${table}" FOR INSERT`);
      expect(source).not.toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}"`);
    }
  });
});

describe("internal application persistence", () => {
  test("creates immutable revisions, detects idempotency misuse, and enforces CAS", async () => {
    if (!available || !client) return;
    const operationId = crypto.randomUUID();
    const created = await createInternalApplication(client.db, {
      workspaceId: first.workspaceId,
      actorSubjectId: first.subjectId,
      request: {
        operationId,
        slug: "maintenance-assistant",
        name: "Maintenance Assistant",
        description: "",
        definition,
      },
    });
    expect(created.application.headRevision).toBe(1);
    expect(created.headRevision.definition).toEqual(definition);

    const replay = await createInternalApplication(client.db, {
      workspaceId: first.workspaceId,
      actorSubjectId: first.subjectId,
      request: {
        operationId,
        slug: "maintenance-assistant",
        name: "Maintenance Assistant",
        description: "",
        definition,
      },
    });
    expect(replay.application.id).toBe(created.application.id);
    const buildOperationId = crypto.randomUUID();
    const buildSessionId = crypto.randomUUID();
    const buildEvidence = await recordInternalApplicationBuildSessionStarted(client.db, {
      workspaceId: first.workspaceId,
      applicationId: created.application.id,
      operationId: buildOperationId,
      expectedApplicationRevision: 1,
      sessionId: buildSessionId,
      targetId: null,
      actorSubjectId: first.subjectId,
    });
    expect(buildEvidence).toMatchObject({
      id: buildOperationId,
      type: "application.build_session_started",
      facts: { sessionId: buildSessionId, applicationRevision: 1 },
    });
    expect(
      await recordInternalApplicationBuildSessionStarted(client.db, {
        workspaceId: first.workspaceId,
        applicationId: created.application.id,
        operationId: buildOperationId,
        expectedApplicationRevision: 1,
        sessionId: buildSessionId,
        targetId: null,
        actorSubjectId: first.subjectId,
      }),
    ).toEqual(buildEvidence);
    await expect(
      createInternalApplication(client.db, {
        workspaceId: first.workspaceId,
        actorSubjectId: first.subjectId,
        request: {
          operationId,
          slug: "different",
          name: "Different",
          description: "",
          definition,
        },
      }),
    ).rejects.toBeInstanceOf(InternalApplicationIdempotencyError);

    const updated = await updateInternalApplication(client.db, {
      workspaceId: first.workspaceId,
      applicationId: created.application.id,
      actorSubjectId: first.subjectId,
      request: {
        operationId: crypto.randomUUID(),
        expectedHeadRevision: 1,
        name: "Maintenance Assistant",
        description: "Uses local governed data.",
        status: "active",
        definition: {
          ...definition,
          compute: { ...definition.compute, memoryMiB: 2048 },
        },
      },
    });
    expect(updated.application.headRevision).toBe(2);
    await expect(
      updateInternalApplication(client.db, {
        workspaceId: first.workspaceId,
        applicationId: created.application.id,
        actorSubjectId: first.subjectId,
        request: {
          operationId: crypto.randomUUID(),
          expectedHeadRevision: 1,
          name: "Stale",
          description: "",
          status: "active",
          definition,
        },
      }),
    ).rejects.toBeInstanceOf(InternalApplicationVersionConflictError);
  }, 180_000);

  test("stores credential-free governed data catalogs and immutable bundles", async () => {
    if (!available || !client) return;
    const application = await createInternalApplication(client.db, {
      workspaceId: first.workspaceId,
      actorSubjectId: first.subjectId,
      request: {
        operationId: crypto.randomUUID(),
        slug: `catalog-${crypto.randomUUID().slice(0, 8)}`,
        name: "Catalog app",
        description: "",
        definition,
      },
    });
    const sourceId = crypto.randomUUID();
    const source = await upsertInternalApplicationDataSource(client.db, {
      workspaceId: first.workspaceId,
      dataSourceId: sourceId,
      actorSubjectId: first.subjectId,
      request: {
        expectedRevision: 0,
        name: `Lab DB ${sourceId}`,
        description: "",
        kind: "postgres",
        allowedAccessModes: ["attach"],
        locator: {
          kind: "postgres",
          host: "postgres.lab.internal",
          port: 5432,
          database: "research",
          schemas: ["public"],
          sslMode: "require",
          credentialConnectionId: null,
        },
        governance: {
          classification: "restricted",
          residencySite: "SINTEF Oslo",
          residencyRegion: "NO",
          externalEgressAllowed: false,
          retentionDays: null,
          owner: "Research IT",
          purpose: "Local demonstrations",
        },
        schemaDefinition: {},
        metadata: {},
        status: "active",
      },
    });
    expect(source.revision).toBe(1);
    expect(
      (await listInternalApplicationDataSources(client.db, first.workspaceId)).some(
        (row) => row.id === sourceId,
      ),
    ).toBe(true);

    const digest = `sha256:${"b".repeat(64)}`;
    const registered = await registerInternalApplicationBundle(client.db, {
      workspaceId: first.workspaceId,
      applicationId: application.application.id,
      actorSubjectId: first.subjectId,
      request: {
        operationId: crypto.randomUUID(),
        applicationRevisionId: application.headRevision.id,
        digest,
        manifest: {
          schemaVersion: 1,
          image: {
            reference: "registry.lab.internal/apps/catalog",
            digest,
            architecture: "amd64",
          },
          staticAssetsDigest: null,
          migrationsDigest: null,
          runtime: {
            command: ["bun", "run", "start"],
            workingDirectory: "/app",
          },
          health: { path: "/healthz", port: 3000 },
          configurationKeys: ["OPENGENI_RUNTIME_URL"],
          sbomDigest: digest,
          provenanceDigest: digest,
        },
      },
    });
    expect(
      (
        await listInternalApplicationBundles(
          client.db,
          first.workspaceId,
          application.application.id,
        )
      )[0]?.id,
    ).toBe(registered.id);
  }, 180_000);

  test("does not disclose an application through another workspace scope", async () => {
    if (!available || !client) return;
    const created = await createInternalApplication(client.db, {
      workspaceId: first.workspaceId,
      actorSubjectId: first.subjectId,
      request: {
        operationId: crypto.randomUUID(),
        slug: `isolated-${crypto.randomUUID().slice(0, 8)}`,
        name: "Isolated",
        description: "",
        definition,
      },
    });
    await expect(
      getInternalApplication(client.db, second.workspaceId, created.application.id),
    ).rejects.toBeInstanceOf(InternalApplicationNotFoundError);
  }, 180_000);

  test("activates a draft only after a durably admitted provider succeeds", async () => {
    if (!available || !client) return;
    const application = await createInternalApplication(client.db, {
      workspaceId: first.workspaceId,
      actorSubjectId: first.subjectId,
      request: {
        operationId: crypto.randomUUID(),
        slug: `activate-${crypto.randomUUID().slice(0, 8)}`,
        name: "Activation lifecycle",
        description: "",
        definition,
      },
    });
    const imageDigest = `sha256:${"c".repeat(64)}`;
    const bundle = await registerInternalApplicationBundle(client.db, {
      workspaceId: first.workspaceId,
      applicationId: application.application.id,
      actorSubjectId: first.subjectId,
      request: {
        operationId: crypto.randomUUID(),
        applicationRevisionId: application.headRevision.id,
        digest: imageDigest,
        manifest: {
          schemaVersion: 1,
          image: {
            reference: "registry.lab.internal/apps/activation",
            digest: imageDigest,
            architecture: "amd64",
          },
          staticAssetsDigest: null,
          migrationsDigest: null,
          runtime: {
            command: ["bun", "run", "start"],
            workingDirectory: "/app",
          },
          health: { path: "/healthz", port: 3000 },
          configurationKeys: ["OPENGENI_RUNTIME_URL"],
          sbomDigest: imageDigest,
          provenanceDigest: imageDigest,
        },
      },
    });
    const targetId = crypto.randomUUID();
    const target = await upsertInternalApplicationDeploymentTarget(client.db, {
      workspaceId: first.workspaceId,
      targetId,
      actorSubjectId: first.subjectId,
      request: {
        expectedRevision: 0,
        name: "Local Kubernetes",
        description: "",
        kind: "kubernetes",
        environment: "development",
        site: "SINTEF Oslo",
        config: {
          kind: "kubernetes",
          apiServer: "https://kubernetes.lab.internal",
          namespace: "internal-apps",
          serviceAccount: "opengeni-internal-apps",
          ingressClass: null,
          ingressNamespace: null,
          internalDomain: "apps.lab.internal",
          registry: "registry.lab.internal",
          storageClasses: [],
          runtimeApiUrl: "http://opengeni-api.opengeni.svc:8000",
          runtimeCredentialSecretPrefix: "activation-runtime",
          dataCredentialSecretPrefix: null,
          allowedEgressCidrs: [],
          credentialConnectionId: null,
        },
        capabilities: {
          architectures: ["amd64"],
          cpuMillicoresMax: 8_000,
          memoryMiBMax: 32_768,
          storageMiBMax: 1_048_576,
          gpuTypes: [],
          supportsNetworkPolicy: true,
          supportsPersistentVolumes: true,
          supportsInternalIngress: true,
          supportsLocalModelRoute: true,
        },
        metadata: {},
        status: "active",
      },
    });
    const planId = crypto.randomUUID();
    const planDigest = `sha256:${"d".repeat(64)}`;
    const plan = {
      schemaVersion: 1 as const,
      digest: planDigest,
      applicationId: application.application.id,
      applicationRevisionId: application.headRevision.id,
      applicationRevision: 1,
      bundleId: bundle.id,
      bundleDigest: bundle.digest,
      targetId: target.id,
      targetRevision: target.revision,
      environment: "development" as const,
      actions: [],
      dataFlows: [],
      runtimeIdentity: "system:serviceaccount:internal-apps:opengeni-internal-apps",
      secretReferences: ["activation-runtime-activation"],
      network: { policyEnforced: true, allowedEgressCidrs: [] },
      modelRoute: "local" as const,
      estimatedMonthlyCostMicros: 1,
      policyChecks: [
        {
          id: "provider-adapter",
          status: "pass" as const,
          message: "Kubernetes adapter available",
        },
      ],
      destructive: false,
      createdAt: new Date().toISOString(),
    };
    await persistInternalApplicationDeploymentPlan(client.db, {
      workspaceId: first.workspaceId,
      actorSubjectId: first.subjectId,
      operationId: planId,
      requestHash: `sha256:${"e".repeat(64)}`,
      plan,
    });
    const applyId = crypto.randomUUID();
    await beginInternalApplicationApply(client.db, {
      workspaceId: first.workspaceId,
      actorSubjectId: first.subjectId,
      operationId: applyId,
      planOperationId: planId,
      expectedPlanDigest: planDigest,
    });
    await settleInternalApplicationApply(client.db, {
      workspaceId: first.workspaceId,
      operationId: applyId,
      actorSubjectId: first.subjectId,
      outcome: "succeeded",
      internalUrl: "https://activation.apps.lab.internal",
      result: { provider: "test" },
    });
    expect(
      (await getInternalApplication(client.db, first.workspaceId, application.application.id))
        .application.status,
    ).toBe("active");

    let [deployment] = await listInternalApplicationDeployments(
      client.db,
      first.workspaceId,
      application.application.id,
    );
    expect(deployment?.status).toBe("running");
    const unknownId = crypto.randomUUID();
    await beginInternalApplicationSimpleOperation(client.db, {
      workspaceId: first.workspaceId,
      deploymentId: deployment!.id,
      operationId: unknownId,
      kind: "observe",
      actorSubjectId: first.subjectId,
      expectedDeploymentRevision: deployment!.revision,
    });
    await settleInternalApplicationSimpleOperation(client.db, {
      workspaceId: first.workspaceId,
      operationId: unknownId,
      actorSubjectId: first.subjectId,
      outcome: "unknown",
      errorCode: "network_ambiguous",
      errorMessage: "Provider response was not observed",
    });
    [deployment] = await listInternalApplicationDeployments(
      client.db,
      first.workspaceId,
      application.application.id,
    );
    const observationId = crypto.randomUUID();
    await beginInternalApplicationSimpleOperation(client.db, {
      workspaceId: first.workspaceId,
      deploymentId: deployment!.id,
      operationId: observationId,
      kind: "observe",
      actorSubjectId: first.subjectId,
      expectedDeploymentRevision: deployment!.revision,
    });
    await settleInternalApplicationSimpleOperation(client.db, {
      workspaceId: first.workspaceId,
      operationId: observationId,
      actorSubjectId: first.subjectId,
      outcome: "succeeded",
      observedStatus: "running",
      result: { provider: "test", availableReplicas: 1 },
    });
    expect(
      await reconcileInternalApplicationUnknownOperation(client.db, {
        workspaceId: first.workspaceId,
        operationId: unknownId,
        observationOperationId: observationId,
        actorSubjectId: first.subjectId,
      }),
    ).toMatchObject({
      id: unknownId,
      status: "completed",
      result: { reconciled: true, reconciledByOperationId: observationId },
    });
    [deployment] = await listInternalApplicationDeployments(
      client.db,
      first.workspaceId,
      application.application.id,
    );
    const retireId = crypto.randomUUID();
    await beginInternalApplicationSimpleOperation(client.db, {
      workspaceId: first.workspaceId,
      deploymentId: deployment!.id,
      operationId: retireId,
      kind: "retire",
      actorSubjectId: first.subjectId,
      expectedDeploymentRevision: deployment!.revision,
    });
    const retired = await settleInternalApplicationSimpleOperation(client.db, {
      workspaceId: first.workspaceId,
      operationId: retireId,
      actorSubjectId: first.subjectId,
      outcome: "succeeded",
      internalUrl: null,
      result: { provider: "test", resourcesDeleted: 4 },
    });
    expect(retired.deployment).toMatchObject({
      status: "retired",
      internalUrl: null,
      desiredBundleId: null,
      activeBundleId: bundle.id,
    });
    expect(
      (
        await listInternalApplicationDeploymentOperations(
          client.db,
          first.workspaceId,
          deployment!.id,
        )
      )[0],
    ).toMatchObject({ id: retireId, kind: "retire", status: "completed" });
    expect(
      (
        await listInternalApplicationEvents(
          client.db,
          first.workspaceId,
          application.application.id,
        )
      ).some((event) => event.type === "deployment.retire_succeeded"),
    ).toBe(true);
  }, 180_000);
});
