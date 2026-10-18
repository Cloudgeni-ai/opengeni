// Continuing an expired browser resume keeps the controller authority alive
// while the controller adopts the retained working copy. That continuation has
// no dispatched operation of its own, so the heartbeat must hold the expired
// resume itself; holding a not-yet-recorded operation failed every
// continuation with "authority was lost" before the controller was called.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  activateBrowserSession,
  bootstrapWorkspace,
  clearSuspendedBrowserSessionController,
  commitBrowserSessionSuspension,
  createDb,
  createSession,
  dispatchBrowserSessionOperation,
  prepareBrowserSessionCreate,
  prepareBrowserSessionResume,
  prepareBrowserSessionSuspend,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { withInteractionHolderHeartbeat } from "../src/interaction-holder-heartbeat";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("expired-browser-resume-heartbeat");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("Expired browser resume heartbeat tests require real PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function expiredResume() {
  const db = client!.db;
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: `expired-resume-account-${suffix}`,
    accountName: "Expired resume",
    workspaceExternalSource: "test",
    workspaceExternalId: `expired-resume-workspace-${suffix}`,
    workspaceName: "Expired resume",
    subjectId: `expired-resume-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
  };
  const createOperationId = crypto.randomUUID();
  const prepared = await prepareBrowserSessionCreate(db, {
    ...scope,
    operationId: createOperationId,
    associatedSessionId: session.id,
    actorSubjectId: grant.subjectId,
    name: "Research browser",
    initialUrl: "https://example.com/",
    placement: { kind: "sandbox_group" as const, sandboxGroupId: session.sandboxGroupId },
    driverId: "opengeni.cdp.v1",
    engine: "chromium" as const,
    headless: true,
    identityId: null,
    baseRevisionId: null,
  });
  const browserSessionId = prepared.session.id;
  const firstGeneration = crypto.randomUUID();
  await dispatchBrowserSessionOperation(db, {
    ...scope,
    operationId: createOperationId,
    browserSessionId,
    controllerGeneration: firstGeneration,
  });
  await activateBrowserSession(db, {
    ...scope,
    operationId: createOperationId,
    browserSessionId,
    controller: {
      controllerId: "browserd:test",
      controllerGeneration: firstGeneration,
      placementInstanceId: "placement:test",
    },
    engineVersion: "151.0.7922.108",
  });
  const suspendOperationId = crypto.randomUUID();
  const objectKey = `workspaces/${scope.workspaceId}/browser-state/checkpoints/${suspendOperationId}.ogbp`;
  await prepareBrowserSessionSuspend(db, {
    ...scope,
    browserSessionId,
    operationId: suspendOperationId,
    actorSubjectId: grant.subjectId,
  });
  await dispatchBrowserSessionOperation(db, {
    ...scope,
    operationId: suspendOperationId,
    browserSessionId,
    controllerGeneration: firstGeneration,
    stateUpload: { objectKey, cleanupAfter: new Date(Date.now() + 60_000) },
  });
  await commitBrowserSessionSuspension(db, {
    ...scope,
    operationId: suspendOperationId,
    browserSessionId,
    controllerGeneration: firstGeneration,
    artifact: {
      kind: "chromium_profile",
      format: "application/vnd.opengeni.browser-profile.v1+tar+gzip+aes256gcm",
      artifactDigest: "a".repeat(64),
      contentDigest: "b".repeat(64),
      manifestDigest: "c".repeat(64),
      objectKey,
      encryptedDataKey: `wrapped-data-key-${suspendOperationId}`,
      sizeBytes: 4_096,
      materialization: {
        portability: "portable",
        reason: null,
        platform: "linux",
        architecture: "x64",
        engine: "chromium",
        engineVersion: "151.0.7922.108",
        driverId: "opengeni.cdp.v1",
        driverSchemaVersion: 1,
        profileCrypto: "chromium_basic",
        providerId: null,
        placement: null,
      },
    },
  });
  await clearSuspendedBrowserSessionController(db, {
    ...scope,
    browserSessionId,
    expectedControllerGeneration: firstGeneration,
  });
  const resumeOperationId = crypto.randomUUID();
  await prepareBrowserSessionResume(db, {
    ...scope,
    browserSessionId,
    operationId: resumeOperationId,
    actorSubjectId: grant.subjectId,
  });
  const retainedGeneration = crypto.randomUUID();
  await dispatchBrowserSessionOperation(db, {
    ...scope,
    operationId: resumeOperationId,
    browserSessionId,
    controllerGeneration: retainedGeneration,
    controller: {
      controllerId: "browserd:test",
      controllerGeneration: retainedGeneration,
      placementInstanceId: "placement:retained",
    },
  });
  // The transition reaper's settlement of a resume whose launch never finished.
  await shared!.admin`
    update interaction_operations
    set state = 'outcome_unknown', error_code = 'outcome_unknown',
        error_message = 'Interaction controller transition heartbeat expired',
        error_retryable = false, settled_at = now(), updated_at = now()
    where workspace_id = ${scope.workspaceId} and operation_id = ${resumeOperationId}`;
  await shared!.admin`
    update browser_sessions
    set lifecycle = 'lost', failure_code = 'controller_transition_expired', updated_at = now()
    where workspace_id = ${scope.workspaceId} and id = ${browserSessionId}`;
  return { grant: grant as AccessGrant, scope, browserSessionId, retainedGeneration };
}

function deps(): ApiRouteDeps {
  return {
    db: client!.db,
    settings: { sandboxInteractionHolderTtlMs: 30_000 },
  } as unknown as ApiRouteDeps;
}

describe("expired browser resume continuation heartbeat", () => {
  test("holds the expired resume while the controller adopts its working copy", async () => {
    if (!client) return;
    const expired = await expiredResume();
    let adopted = false;
    await withInteractionHolderHeartbeat(
      deps(),
      {
        grant: expired.grant,
        workspaceId: expired.scope.workspaceId,
        sandboxGroupId: null,
        holderId: `browser:${expired.browserSessionId}`,
        // The continuation's own operation, not recorded until adoption.
        operationId: crypto.randomUUID(),
        continuesExpiredBrowserResume: true,
        resourceId: expired.browserSessionId,
        controllerGeneration: expired.retainedGeneration,
      },
      async () => {
        adopted = true;
      },
    );
    expect(adopted).toBe(true);
  });

  test("refuses a continuation whose controller generation no longer holds the browser", async () => {
    if (!client) return;
    const expired = await expiredResume();
    let ran = false;
    await expect(
      withInteractionHolderHeartbeat(
        deps(),
        {
          grant: expired.grant,
          workspaceId: expired.scope.workspaceId,
          sandboxGroupId: null,
          holderId: `browser:${expired.browserSessionId}`,
          operationId: crypto.randomUUID(),
          continuesExpiredBrowserResume: true,
          resourceId: expired.browserSessionId,
          controllerGeneration: crypto.randomUUID(),
        },
        async () => {
          ran = true;
        },
      ),
    ).rejects.toThrow("authority was lost");
    expect(ran).toBe(false);
  });
});
