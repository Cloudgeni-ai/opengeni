import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  testSettings,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  acquireLease,
  bootstrapWorkspace,
  createDb,
  createSessionWithIdempotencyKeyResult,
  inspectNativeCommandProviderQualification,
  publishNativeCommandQualification,
  readLease,
  recordRecoveredModalProviderCreate,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { provisionRoles } from "@opengeni/db/provision-roles";
import * as sourceIdentity from "@opengeni/config/server-source-identity";
import type { Settings } from "@opengeni/config";
import * as sandbox from "@opengeni/runtime/sandbox";
import {
  createModalProviderCreateBoundary,
  type ModalCreateImagePreparation,
  type ModalCreateIntent,
} from "../../../packages/runtime/src/sandbox/providers/modal-create-boundary";
import { establishApiSandboxSpawner } from "../src/sandbox/rematerialize";
import { releaseModalCreateFailure } from "../../../packages/runtime/src/sandbox/providers/modal-create-session";

let fixture: OwnerMigratedTestDatabase, app: DbClient, owner: DbClient;
const SOURCE = "a".repeat(40);
const IMAGE = `ghcr.io/cloudgeni-ai/opengeni-desktop@sha256:${"b".repeat(64)}`;
const PROVIDER_IMAGE = "im-api-native-fixture";
const BINDING = {
  version: 1 as const,
  serverUrl: "https://api.modal.test",
  workspaceName: "api-native-fixture",
  environment: "api-native-fixture",
};
const BINDING_KEY = JSON.stringify(BINDING);
const settings = testSettings({
  sandboxBackend: "modal",
  modalImageRef: IMAGE,
  sandboxOwnershipEnabled: true,
  sandboxLeaseTtlMs: 60_000,
  sandboxLeaseWarmingTtlMs: 60_000,
});
// Controlled dependency observations only. Production has no source override.
const source = spyOn(sourceIdentity, "readImmutableServerSourceSha").mockResolvedValue(SOURCE);
const tags = spyOn(sandbox, "tagModalSandbox").mockResolvedValue(undefined);

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("api-modal-create-qualification");
  if (!acquired) throw new Error("API Modal create requires isolated PostgreSQL");
  fixture = acquired;
  await migrate(fixture.ownerUrl, "public", {
    preinstalledVector: true,
    applicationDatabaseRoles: ["opengeni_app"],
  });
  await provisionRoles(fixture.adminUrl, { appPassword: fixture.appPassword });
  const appUrl = new URL(fixture.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = fixture.appPassword;
  app = createDb(appUrl.toString(), { max: 3 });
  owner = createDb(fixture.ownerUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  source.mockRestore();
  tags.mockRestore();
  await app?.close();
  await owner?.close();
  await fixture?.release();
}, 60_000);

async function coldBirth(qualified = true) {
  const runId = crypto.randomUUID();
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "test",
    accountExternalId: runId,
    accountName: "API native create",
    workspaceExternalSource: "test",
    workspaceExternalId: runId,
    workspaceName: "API native create",
    subjectId: `api-native-${runId}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const createIdempotencyKey = `api-native-cohort-${runId}`;
  const qualification = {
    ...scope,
    id: crypto.randomUUID(),
    creatorSubjectId: grant.subjectId,
    createIdempotencyKey,
    activationGeneration: 1,
    sourceSha: SOURCE,
    imageRef: IMAGE,
    providerImageId: PROVIDER_IMAGE,
    providerBindingKey: BINDING_KEY,
    protocols: ["native-subreaper-v1", "native-subreaper-pty-v1"] as [
      "native-subreaper-v1",
      "native-subreaper-pty-v1",
    ],
    acceptanceEvidenceHash: "c".repeat(64),
    enrollmentEnabled: true,
  };
  if (qualified) await publishNativeCommandQualification(owner.db, qualification);
  const created = await createSessionWithIdempotencyKeyResult(app.db, {
    ...scope,
    subjectId: grant.subjectId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    createIdempotencyKey,
    sandboxBackend: "modal",
    initialMessage: "API cold fixture",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
  });
  if (created.denied || !created.created) throw new Error("Expected fresh canonical session");
  const groupScope = { ...scope, sandboxGroupId: created.session.sandboxGroupId };
  const acquired = await acquireLease(app.db, {
    ...groupScope,
    kind: "direct",
    holderId: `direct-request:${runId}`,
    subjectId: created.session.id,
    backend: "modal",
    image: IMAGE,
    imagePolicy: "new_creates_only",
    leaseTtlMs: 60_000,
    warmingLeaseTtlMs: settings.sandboxWarmingTimeoutMs,
  });
  if (acquired.role !== "spawner")
    throw new Error(`Expected cold API spawner, got ${acquired.role}`);
  return { ...groupScope, sessionId: created.session.id, acquired, qualification };
}

type ColdBirth = Awaited<ReturnType<typeof coldBirth>>;
type Lifecycle = {
  beforeDispatch: (intent: ModalCreateIntent, context: unknown) => Promise<void>;
  onCreated: (session: unknown, receipt: ModalCreateIntent) => Promise<void>;
};
function provider(
  birth: ColdBirth,
  options: {
    preparation?: ModalCreateImagePreparation | null;
    binding?: typeof BINDING;
    receiptBinding?: typeof BINDING;
    lostReply?: boolean;
    readinessFailure?: boolean;
    unknownSetupStart?: boolean;
  } = {},
) {
  const observed = {
    dispatches: 0,
    closes: 0,
    readiness: 0,
    transportCloses: 0,
    originalIntent: null as ModalCreateIntent | null,
    atDispatch: null as Awaited<ReturnType<typeof readLease>>,
    afterReceipt: null as Awaited<ReturnType<typeof readLease>>,
  };
  const context = (binding: typeof BINDING) => ({
    modal: {
      profile: { serverUrl: binding.serverUrl },
      cpClient: { workspaceNameLookup: async () => ({ workspaceName: binding.workspaceName }) },
      environmentName: () => binding.environment,
    },
  });
  const instanceId = `sb-${crypto.randomUUID()}`;
  const state = { sandboxId: instanceId, imageId: options.preparation?.imageId ?? PROVIDER_IMAGE };
  const cursor = () => ({ byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null });
  const unknownSetupError = new sandbox.ProviderCommandStartOutcomeUnknownError(
    {
      kind: "modal-router-v1",
      sandboxId: instanceId,
      taskId: "ta-api-native-setup",
      execId: `ex-${crypto.randomUUID()}`,
      streams: { stdout: cursor(), stderr: cursor() },
    },
    new Error("fixture setup Start acknowledgement lost"),
  );
  const handle = {
    ...context(options.receiptBinding ?? options.binding ?? BINDING),
    state,
    close: async () => {
      observed.closes++;
    },
    verifyExecReadiness: async () => {
      observed.readiness++;
      if (options.readinessFailure) throw new Error("fixture startup failed after receipt");
      return 0;
    },
  };
  const create = async (lifecycle?: Lifecycle) => {
    const boundary = createModalProviderCreateBoundary({
      operationId: crypto.randomUUID(),
      imagePreparation: () =>
        options.preparation === null
          ? undefined
          : (options.preparation ?? {
              kind: "registry-import",
              imageRef: IMAGE,
              imageId: PROVIDER_IMAGE,
            }),
      beforeDispatch: async (intent) => {
        observed.originalIntent = intent;
        await lifecycle?.beforeDispatch(intent, context(options.binding ?? BINDING));
      },
      onReceipt: async (receipt) => {
        await lifecycle?.onCreated(handle, receipt);
      },
    });
    const iterator = boundary(
      {
        method: { path: "/modal.client.ModalClient/SandboxCreate" },
        requestStream: false,
        responseStream: false,
        request: { appId: "ap-api-native", definition: { imageId: state.imageId }, tags: [] },
        // Unary middleware returns the exact controlled provider response.
        // eslint-disable-next-line require-yield -- Unary nice-grpc returns its response through the generator's return value.
        next: async function* (_wire: unknown, callOptions: { retries: number }) {
          expect(callOptions.retries).toBe(0);
          observed.dispatches++;
          observed.atDispatch = await readLease(app.db, birth.workspaceId, birth.sandboxGroupId);
          if (options.lostReply) throw new Error("fixture provider reply lost after allocation");
          return { sandboxId: instanceId };
        },
      } as never,
      {},
    );
    let response = await iterator.next();
    while (!response.done) response = await iterator.next();
    observed.afterReceipt = await readLease(app.db, birth.workspaceId, birth.sandboxGroupId);
    if (options.unknownSetupStart) {
      // The actual runtime cleanup must preserve the instance before the API
      // receives an uncertain setup failure from SDK applyManifest.
      await releaseModalCreateFailure(
        handle,
        {
          close: () => {
            observed.transportCloses++;
          },
        },
        unknownSetupError,
      );
    }
    return handle;
  };
  return {
    observed,
    instanceId,
    unknownSetupError,
    client: {
      backendId: "modal",
      create: async () => await create(),
      createWithLifecycle: async (_args: unknown, lifecycle: Lifecycle) => await create(lifecycle),
      serializeSessionState: async (sessionState: unknown) => sessionState,
    },
  };
}
async function establish(
  birth: ColdBirth,
  fake: ReturnType<typeof provider>,
  createSettings: Settings = settings,
) {
  return await establishApiSandboxSpawner({
    db: app.db,
    settings: createSettings,
    accountId: birth.accountId,
    workspaceId: birth.workspaceId,
    sandboxGroupId: birth.sandboxGroupId,
    sessionId: birth.sessionId,
    backend: "modal",
    environment: {},
    expectedEpoch: birth.acquired.lease.leaseEpoch,
    acquiredLease: birth.acquired.lease,
    fallbackEnvelope: null,
    dataPlaneUrl: null,
    clientFactory: () => fake.client,
  });
}

test("cold API qualified birth persists original intent before provider dispatch and receipt before setup/warm", async () => {
  const birth = await coldBirth();
  const fake = provider(birth);
  const result = await establish(birth, fake);
  expect(fake.observed.dispatches).toBe(1);
  const intent = fake.observed.originalIntent!;
  expect(fake.observed.atDispatch?.providerCreateAttempt).toMatchObject({
    operationId: intent.operationId,
    imageId: intent.imageId,
    requestSha256: intent.requestSha256,
    providerBindingKey: BINDING_KEY,
    leaseEpoch: birth.acquired.lease.leaseEpoch,
    instanceId: null,
    nativeCommandQualification: { qualificationId: birth.qualification.id },
  });
  expect(fake.observed.afterReceipt?.liveness).toBe("warming");
  expect(fake.observed.afterReceipt?.providerCreateAttempt?.instanceId).toBe(fake.instanceId);
  expect(fake.observed.afterReceipt?.providerCreateAttempt).toEqual({
    ...fake.observed.atDispatch?.providerCreateAttempt,
    instanceId: fake.instanceId,
  });
  expect(fake.observed.readiness).toBe(1);
  expect(result.lease.liveness).toBe("warm");
  expect(result.lease.leaseEpoch).toBe(birth.acquired.lease.leaseEpoch + 1);
  for (const protocol of birth.qualification.protocols) {
    expect(
      await inspectNativeCommandProviderQualification(app.db, {
        ...birth,
        providerInstanceId: fake.instanceId,
        leaseEpoch: result.lease.leaseEpoch,
        protocol,
        sourceSha: SOURCE,
      }),
    ).toMatchObject({ status: "enrolled", qualification: { id: birth.qualification.id } });
  }
  expect(source).toHaveBeenCalled();
});

test("cold API legacy birth retains ordinary command ownership with the same durable create boundary", async () => {
  source.mockResolvedValue(undefined);
  try {
    const birth = await coldBirth(false);
    const fake = provider(birth);
    const result = await establish(birth, fake);
    expect(fake.observed.dispatches).toBe(1);
    expect(fake.observed.atDispatch?.providerCreateAttempt?.operationId).toBe(
      fake.observed.originalIntent?.operationId,
    );
    expect(
      fake.observed.atDispatch?.providerCreateAttempt?.nativeCommandQualification,
    ).toBeUndefined();
    expect(fake.observed.afterReceipt?.providerCreateAttempt?.instanceId).toBe(fake.instanceId);
    expect(result.lease.liveness).toBe("warm");
    expect(
      await inspectNativeCommandProviderQualification(app.db, {
        ...birth,
        providerInstanceId: fake.instanceId,
        leaseEpoch: result.lease.leaseEpoch,
        protocol: "native-subreaper-v1",
        sourceSha: SOURCE,
      }),
    ).toEqual({ status: "legacy" });
  } finally {
    source.mockResolvedValue(SOURCE);
  }
});

test("cold API rejects wrong source, missing preparation, custom image and namespace before dispatch", async () => {
  for (const mismatch of [
    "source",
    "missing-source",
    "preparation",
    "image",
    "custom",
    "namespace",
  ] as const) {
    const birth = await coldBirth();
    if (mismatch === "source") source.mockResolvedValue("f".repeat(40));
    if (mismatch === "missing-source") source.mockResolvedValue(undefined);
    const fake = provider(
      birth,
      mismatch === "preparation"
        ? { preparation: null }
        : mismatch === "namespace"
          ? {
              binding: { ...BINDING, workspaceName: "unrelated-namespace" },
            }
          : mismatch === "image"
            ? {
                preparation: {
                  kind: "registry-import",
                  imageRef: IMAGE,
                  imageId: "im-unrelated-physical",
                },
              }
            : mismatch === "custom"
              ? {
                  preparation: { kind: "provider-image-id", imageId: PROVIDER_IMAGE },
                }
              : {},
    );
    try {
      const selectedSettings =
        mismatch === "custom"
          ? testSettings({ ...settings, modalImageId: PROVIDER_IMAGE })
          : settings;
      await expect(establish(birth, fake, selectedSettings)).rejects.toThrow();
      expect(fake.observed.dispatches).toBe(0);
      expect(fake.observed.closes).toBe(0);
      const retained = await readLease(app.db, birth.workspaceId, birth.sandboxGroupId);
      expect(retained?.liveness).toBe("cold");
      expect(retained?.instanceId).toBeNull();
      expect(retained?.providerCreateAttempt).toBeNull();
    } finally {
      source.mockResolvedValue(SOURCE);
    }
  }
});

test("lost cold API create reply remains unknown, cannot replay, and retains exact positive late attribution", async () => {
  const birth = await coldBirth();
  const fake = provider(birth, { lostReply: true });
  await expect(establish(birth, fake)).rejects.toThrow(
    "fixture provider reply lost after allocation",
  );
  expect(fake.observed.dispatches).toBe(1);
  expect(fake.observed.closes).toBe(0);
  const unresolved = await readLease(app.db, birth.workspaceId, birth.sandboxGroupId);
  expect(unresolved?.liveness).toBe("warming");
  expect(unresolved?.instanceId).toBeNull();
  const attempt = unresolved?.providerCreateAttempt;
  if (!attempt) throw new Error("Unknown create lost its original durable attempt");
  expect(attempt.operationId).toBe(fake.observed.originalIntent?.operationId);
  expect(attempt.instanceId).toBeNull();
  const rival = provider(birth);
  await expect(establish(birth, rival)).rejects.toThrow("provider_create_outcome_unknown");
  expect(rival.observed.dispatches).toBe(0);
  expect(
    (await readLease(app.db, birth.workspaceId, birth.sandboxGroupId))?.providerCreateAttempt,
  ).toEqual(attempt);
  expect(
    await recordRecoveredModalProviderCreate(app.db, {
      ...birth,
      attempt,
      instanceId: fake.instanceId,
    }),
  ).toBe(true);
  const attributed = await readLease(app.db, birth.workspaceId, birth.sandboxGroupId);
  expect(attributed?.liveness).toBe("warming");
  expect(attributed?.providerCreateAttempt).toEqual({ ...attempt, instanceId: fake.instanceId });
  expect(
    await inspectNativeCommandProviderQualification(app.db, {
      ...birth,
      providerInstanceId: fake.instanceId,
      leaseEpoch: attributed!.leaseEpoch,
      protocol: "native-subreaper-v1",
      sourceSha: SOURCE,
    }),
  ).toMatchObject({ status: "blocked", reason: "physical_binding_unqualified" });
});

test("API create receipt from another authenticated namespace cannot attribute or publish warm", async () => {
  const birth = await coldBirth();
  const fake = provider(birth, {
    receiptBinding: { ...BINDING, workspaceName: "foreign-receipt" },
  });
  await expect(establish(birth, fake)).rejects.toThrow("crossed the fenced provider namespace");
  expect(fake.observed.dispatches).toBe(1);
  expect(fake.observed.closes).toBeGreaterThan(0);
  expect(fake.observed.readiness).toBe(0);
  const lease = await readLease(app.db, birth.workspaceId, birth.sandboxGroupId);
  expect(lease?.liveness).toBe("warming");
  expect(lease?.instanceId).toBeNull();
  expect(lease?.providerCreateAttempt?.instanceId).toBeNull();
});

test("API readiness failure after exact create receipt cleans up the attributed box and preserves its operation", async () => {
  const birth = await coldBirth();
  const fake = provider(birth, { readinessFailure: true });
  await expect(establish(birth, fake)).rejects.toThrow();
  expect(fake.observed.dispatches).toBe(1);
  expect(fake.observed.afterReceipt?.providerCreateAttempt?.instanceId).toBe(fake.instanceId);
  expect(fake.observed.closes).toBeGreaterThan(0);
  const lease = await readLease(app.db, birth.workspaceId, birth.sandboxGroupId);
  expect(lease?.liveness).toBe("cold");
  expect(lease?.instanceId).toBeNull();
  expect(lease?.providerCreateAttempt?.instanceId).toBe(fake.instanceId);
  expect(
    await inspectNativeCommandProviderQualification(app.db, {
      ...birth,
      providerInstanceId: fake.instanceId,
      leaseEpoch: lease!.leaseEpoch,
      protocol: "native-subreaper-v1",
      sourceSha: SOURCE,
    }),
  ).toMatchObject({ status: "blocked" });
});

test("cold API preserves the attributed instance and original create when setup Start outcome is unknown", async () => {
  const birth = await coldBirth();
  const fake = provider(birth, { unknownSetupStart: true });
  await expect(establish(birth, fake)).rejects.toBe(fake.unknownSetupError);
  expect(fake.observed.dispatches).toBe(1);
  expect(fake.observed.transportCloses).toBe(1);
  expect(fake.observed.closes).toBe(0);
  expect(fake.observed.readiness).toBe(0);
  const lease = await readLease(app.db, birth.workspaceId, birth.sandboxGroupId);
  expect(lease?.liveness).toBe("warming");
  expect(lease?.instanceId).toBe(fake.instanceId);
  expect(lease?.leaseEpoch).toBe(birth.acquired.lease.leaseEpoch);
  expect(lease?.providerCreateAttempt).toEqual(fake.observed.afterReceipt?.providerCreateAttempt);
  expect(lease?.providerCreateAttempt).toMatchObject({
    operationId: fake.observed.originalIntent!.operationId,
    instanceId: fake.instanceId,
    nativeCommandQualification: { qualificationId: birth.qualification.id },
  });
  expect(fake.unknownSetupError.command).toMatchObject({
    sandboxId: fake.instanceId,
    taskId: "ta-api-native-setup",
  });
  const retry = await acquireLease(app.db, {
    accountId: birth.accountId,
    workspaceId: birth.workspaceId,
    sandboxGroupId: birth.sandboxGroupId,
    kind: "direct",
    holderId: `direct-retry:${crypto.randomUUID()}`,
    subjectId: birth.sessionId,
    backend: "modal",
    image: IMAGE,
    imagePolicy: "new_creates_only",
    leaseTtlMs: 60_000,
    warmingLeaseTtlMs: settings.sandboxWarmingTimeoutMs,
  });
  expect(retry.role).toBe("attached");
  expect(retry.lease?.liveness).toBe("warming");
  expect(retry.lease?.instanceId).toBe(fake.instanceId);
  expect(retry.lease?.providerCreateAttempt).toEqual(lease?.providerCreateAttempt);
  expect(
    await inspectNativeCommandProviderQualification(app.db, {
      ...birth,
      providerInstanceId: fake.instanceId,
      leaseEpoch: lease!.leaseEpoch,
      protocol: "native-subreaper-v1",
      sourceSha: SOURCE,
    }),
  ).toMatchObject({ status: "blocked", reason: "physical_binding_unqualified" });
});
