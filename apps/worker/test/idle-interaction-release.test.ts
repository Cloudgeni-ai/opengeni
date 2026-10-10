// Idle browser and desktop release: a BrowserSession or ComputerSession that
// nobody uses must not keep its Modal box warm until the provider deadline.
// Drives the real reaper activities (prepare sweep -> browser checkpoint ->
// drain) and the real lease/interaction ledger against PostgreSQL; only the
// browser controller and the provider snapshot + stop are faked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { BROWSER_PROFILE_ARTIFACT_FORMAT } from "@opengeni/contracts";
import {
  browserDeadlineCheckpoint,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  MANAGED_BROWSER_SESSION_CAPABILITIES,
  prepareBrowserSessionResume,
  touchBrowserSessionController,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import {
  BrowserControlRequestError,
  type BrowserControlClient,
  type CapturePlacementBrowserStateInput,
  type PlacementBrowserStateCaptureReceipt,
} from "@opengeni/runtime";
import type { ObjectStorage } from "@opengeni/storage";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import { createBrowserDeadlineCheckpointActivities } from "../src/activities/browser-deadline-checkpoint";
import { createSandboxLeaseActivities, type TerminateBoxFn } from "../src/activities/sandbox-lease";
import type { ActivityServices, ControlActivityServices } from "../src/activities/types";

const IDLE_MS = 15 * 60_000;
const EPOCH = 3;
const SETTINGS = testSettings({
  sandboxBackend: "modal",
  webSearchEnabled: false,
  sandboxOwnershipEnabled: true,
  sandboxViewerHolderTtlMs: 90_000,
  sandboxInteractionHolderTtlMs: 180_000,
  sandboxIdleGraceMs: IDLE_MS,
  sandboxIdleCommandContainmentMs: 30 * 60_000,
  sandboxLeaseReaperPeriodMs: 30_000,
  environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
});

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-idle-interaction-release");
  if (!shared) throw new Error("Real PostgreSQL required for idle interaction release");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const storage = {
  createPutUrl: async () => ({
    url: "https://storage.example.test/checkpoint",
    requiredHeaders: {},
    expiresAt: new Date(Date.now() + 60_000),
  }),
} as unknown as ObjectStorage;

function services(objectStorage: ObjectStorage | null = storage) {
  return async () =>
    ({
      settings: SETTINGS,
      db,
      bus: null as never,
      runtime: null as never,
      objectStorage,
      documentServices: null as never,
      observability: createObservability(SETTINGS, { component: "worker-test" }),
      wakeSessionWorkflow: null,
    }) as ActivityServices;
}

function archiveDescriptor(archive: string) {
  const bytes = Buffer.from(archive, "base64");
  const archiveSha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return {
    version: 1 as const,
    revision: `wa1:1900000000000:${archiveSha256}`,
    archiveSha256,
    archiveBytes: bytes.length,
    capturedAt: new Date(1_900_000_000_000).toISOString(),
    workspace: {
      algorithm: "sha256" as const,
      sha256: archiveSha256,
      entryCount: 1,
      fileCount: 1,
      totalFileBytes: bytes.length,
    },
  };
}

/** Provider seam: verified /workspace capture, then "stop", in production order. */
function terminateSpy() {
  const persisted: boolean[] = [];
  const fn: TerminateBoxFn = async (_settings, _lease, _observability, persistArchive) => {
    const archive = Buffer.from("IDLE_INTERACTION_ARCHIVE").toString("base64");
    const { wrote } = await persistArchive(archive, archiveDescriptor(archive));
    persisted.push(wrote);
    return wrote;
  };
  return { fn, persisted };
}

function receipt(input: CapturePlacementBrowserStateInput): PlacementBrowserStateCaptureReceipt {
  return {
    browserSessionId: input.browserSessionId,
    controllerGeneration: input.controllerGeneration,
    operationId: input.operationId,
    objectKey: input.objectKey,
    format: BROWSER_PROFILE_ARTIFACT_FORMAT,
    artifactDigest: "a".repeat(64),
    contentDigest: "b".repeat(64),
    sizeBytes: 4096,
    fileCount: 1,
    profileBytes: 2048,
    manifest: {
      schemaVersion: 1,
      browserSessionId: input.browserSessionId,
      controllerGeneration: input.controllerGeneration,
      capturedAt: new Date().toISOString(),
      engine: "chromium",
      engineVersion: "151.0.7922.108",
      driverId: "opengeni.cdp.v1",
      driverSchemaVersion: 1,
      profileCrypto: "chromium_basic",
      platform: "linux",
      architecture: "x64",
      tabs: [{ url: "https://example.test/", selected: true }],
    },
  };
}

type FakeController = Pick<BrowserControlClient, "captureState" | "endSession">;

function browserCheckpoints(controller: FakeController) {
  return createBrowserDeadlineCheckpointActivities(
    async () =>
      ({ settings: SETTINGS, db, objectStorage: storage }) as unknown as ControlActivityServices,
    async ({ target, lease }) => {
      expect(lease.instanceId).toBe(target.instanceId);
      return controller;
    },
  );
}

function savingController() {
  const calls = { captures: 0, cleanups: 0 };
  const controller: FakeController = {
    captureState: async (input) => {
      calls.captures++;
      expect(input.afterCapture).toBe("stop");
      return receipt(input);
    },
    endSession: async () => {
      calls.cleanups++;
    },
  };
  return { controller, calls };
}

async function finishedSession(ids: { accountId: string; workspaceId: string }) {
  const session = await createSession(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    initialMessage: "look something up in the browser",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, ids.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `idle-interaction-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`fixture turn not claimed: ${claim.reason}`);
  return {
    sessionId: session.id,
    sandboxGroupId: session.sandboxGroupId!,
    turnId: claim.turn.id,
    attemptId,
  };
}

async function finishTurn(turn: { attemptId: string; turnId: string; sessionId: string }) {
  await admin`update session_turn_attempts set state = 'closed', outcome = 'completed',
    closed_at = now(), quiesced_at = now() where id = ${turn.attemptId}`;
  await admin`update session_turns set status = 'completed', finished_at = now(),
    active_attempt_id = null where id = ${turn.turnId}`;
  await admin`update sessions set status = 'idle', active_turn_id = null
    where id = ${turn.sessionId} and active_turn_id = ${turn.turnId}`;
}

/** A finished agent session whose warm Modal box is held only by the browser
 * and desktop the agent opened. The browser is shown inside the desktop, as
 * the web app creates a person's browser. */
async function fixture(
  options: { checkpoint?: boolean; linked?: boolean; turnOpen?: boolean } = {},
) {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('idle interaction') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'idle interaction') returning id`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${ids.workspaceId}, ${ids.accountId})`;
  await admin`insert into workspace_interaction_revisions (workspace_id, account_id)
    values (${ids.workspaceId}, ${ids.accountId})`;
  const turn = await finishedSession(ids);
  if (!options.turnOpen) await finishTurn(turn);
  const instanceId = `box-${crypto.randomUUID()}`;
  const [lease] = await admin<{ id: string }[]>`
    insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch, resume_backend_id,
      resume_state, expires_at, provider_created_at, provider_deadline_at)
    values (${ids.accountId}, ${ids.workspaceId}, ${turn.sandboxGroupId}, 'warm', 0, 0, 0,
      ${instanceId}, 'modal', ${EPOCH}, 'modal',
      ${JSON.stringify({ backendId: "modal", sessionState: { providerState: { sandboxId: instanceId } } })}::text::jsonb,
      now() + interval '10 minutes', now() - interval '1 hour', now() + interval '23 hours')
    returning id`;
  const computerId = crypto.randomUUID();
  const computerGeneration = crypto.randomUUID();
  const computerOperationId = crypto.randomUUID();
  await admin`insert into interaction_operations (operation_id, account_id, workspace_id,
      resource_kind, resource_id, kind, request_digest, state, controller_generation,
      actor_subject_id, dispatched_at, settled_at)
    values (${computerOperationId}, ${ids.accountId}, ${ids.workspaceId}, 'computer_session',
      ${computerId}, 'create', ${"a".repeat(64)}, 'completed', ${computerGeneration},
      'fixture-human', now(), now())`;
  await admin`insert into computer_sessions (id, account_id, workspace_id, name, lifecycle,
      placement_kind, sandbox_group_id, controller_id, controller_generation,
      placement_instance_id, platform, adapter, seat_id, display_id, capabilities,
      create_operation_id, created_by_subject_id, controller_heartbeat_at)
    values (${computerId}, ${ids.accountId}, ${ids.workspaceId}, 'Browser desktop', 'active',
      'sandbox_group', ${turn.sandboxGroupId}, 'computerd:fixture', ${computerGeneration},
      ${instanceId}, 'linux', 'native', 'seat-1', 'display-1', '{}'::jsonb,
      ${computerOperationId}, 'fixture-human', now())`;
  const browserId = crypto.randomUUID();
  const browserGeneration = crypto.randomUUID();
  const browserOperationId = crypto.randomUUID();
  await admin`insert into interaction_operations (operation_id, account_id, workspace_id,
      resource_kind, resource_id, kind, request_digest, state, controller_generation,
      actor_subject_id, dispatched_at, settled_at)
    values (${browserOperationId}, ${ids.accountId}, ${ids.workspaceId}, 'browser_session',
      ${browserId}, 'create', ${"a".repeat(64)}, 'completed', ${browserGeneration},
      'fixture-human', now(), now())`;
  await admin`insert into browser_sessions (id, account_id, workspace_id, name, lifecycle,
      placement_kind, sandbox_group_id, controller_host_sandbox_group_id, controller_id,
      controller_generation, placement_instance_id, driver_id, engine, headless, capabilities,
      create_operation_id, created_by_subject_id, controller_heartbeat_at,
      linked_computer_session_id)
    values (${browserId}, ${ids.accountId}, ${ids.workspaceId}, 'Browser', 'active',
      'sandbox_group', ${turn.sandboxGroupId}, ${turn.sandboxGroupId}, 'browserd:fixture',
      ${browserGeneration}, ${instanceId}, 'opengeni.cdp.v1', 'chromium', false,
      ${JSON.stringify({ ...MANAGED_BROWSER_SESSION_CAPABILITIES, privateCheckpoint: options.checkpoint ?? true })}::text::jsonb,
      ${browserOperationId}, 'fixture-human', now(),
      ${options.linked === false ? null : computerId})`;
  for (const holderId of [`browser-session:${browserId}`, `computer-session:${computerId}`]) {
    await admin`insert into sandbox_lease_holders (account_id, workspace_id, lease_id, kind,
        holder_id, last_heartbeat_at)
      values (${ids.accountId}, ${ids.workspaceId}, ${lease!.id}, 'interaction', ${holderId}, now())`;
  }
  await admin`update sandbox_leases set refcount = 2 where id = ${lease!.id}`;
  return {
    ...ids,
    ...turn,
    leaseId: lease!.id,
    instanceId,
    browserId,
    browserGeneration,
    computerId,
    computerGeneration,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Nobody touched the session, its browser or its desktop for `minutes`: the
 * live views were closed or hidden, so their polls and heartbeats stopped. */
async function idleFor(f: Fixture, minutes: number) {
  const ago = `${minutes} minutes`;
  await admin`update session_turns set finished_at = now() - ${ago}::interval
    where workspace_id = ${f.workspaceId} and finished_at is not null`;
  await admin`update session_turn_attempts set closed_at = now() - ${ago}::interval,
      updated_at = now() - ${ago}::interval,
      quiesced_at = case when quiesced_at is null then null else now() - ${ago}::interval end
    where workspace_id = ${f.workspaceId} and state = 'closed'`;
  await admin`update sandbox_lease_holders set last_heartbeat_at = now() - ${ago}::interval
    where lease_id = ${f.leaseId}`;
  await admin`update browser_sessions set last_used_at = now() - ${ago}::interval,
      controller_heartbeat_at = now() - ${ago}::interval
    where id = ${f.browserId}`;
  await admin`update computer_sessions set last_used_at = now() - ${ago}::interval,
      controller_heartbeat_at = now() - ${ago}::interval
    where id = ${f.computerId}`;
  await admin`update sandbox_leases set holders_changed_at = now() - ${ago}::interval
    where id = ${f.leaseId}`;
}

async function state(f: Fixture) {
  const [lease] = await admin<
    { liveness: string; refcount: number; drainable: boolean; holders_changed_at: Date }[]
  >`select liveness, refcount, (liveness = 'draining' and expires_at < now()) as drainable,
      holders_changed_at
    from sandbox_leases where id = ${f.leaseId}`;
  const [browser] = await admin<
    {
      lifecycle: string;
      failure_code: string | null;
      controller_generation: string | null;
      linked_computer_session_id: string | null;
      private_checkpoint_artifact_id: string | null;
    }[]
  >`select lifecycle, failure_code, controller_generation, linked_computer_session_id,
      private_checkpoint_artifact_id
    from browser_sessions where id = ${f.browserId}`;
  const [computer] = await admin<{ lifecycle: string; failure_code: string | null }[]>`
    select lifecycle, failure_code from computer_sessions where id = ${f.computerId}`;
  const holders = await admin<{ holder_id: string }[]>`
    select holder_id from sandbox_lease_holders where lease_id = ${f.leaseId} order by holder_id`;
  return {
    lease: lease!,
    browser: browser!,
    computer: computer!,
    holders: holders.map((h) => h.holder_id),
  };
}

function sweep(objectStorage: ObjectStorage | null = storage) {
  return createSandboxLeaseActivities(services(objectStorage)).prepareSandboxLeaseSweep();
}

async function drain(f: Fixture) {
  const spy = terminateSpy();
  // Inline archive persistence; object storage is only the browser's here.
  const result = await createSandboxLeaseActivities(services(null), {
    terminateBox: spy.fn,
  }).drainSandboxLease({
    target: {
      workspaceId: f.workspaceId,
      sandboxGroupId: f.sandboxGroupId,
      instanceId: f.instanceId,
      leaseEpoch: EPOCH,
    },
    timeoutClass: "fast",
    snapshotTimeoutMs: 60_000,
    captureTimeoutMs: 120_000,
    operationId: crypto.randomUUID(),
  });
  return { result, persisted: spy.persisted };
}

function inPlan(plan: { drainable: { sandboxGroupId: string }[] }, f: Fixture) {
  return plan.drainable.some((target) => target.sandboxGroupId === f.sandboxGroupId);
}

describe("idle browser and desktop release", () => {
  test("an unwatched browser and desktop save and stop with the box after the idle timeout", async () => {
    const f = await fixture();
    await idleFor(f, 16);

    // First sweep: the desktop cannot be saved, so it is released; the
    // browser starts saving its profile. The box stays up for that save.
    const first = await sweep();
    expect(inPlan(first, f)).toBe(false);
    let current = await state(f);
    expect(current.computer).toEqual({ lifecycle: "lost", failure_code: "idle_released" });
    expect(current.browser.lifecycle).toBe("suspending");
    expect(current.holders).toEqual([`browser-session:${f.browserId}`]);
    expect(current.lease.liveness).toBe("warm");

    const { controller, calls } = savingController();
    const checkpoints = browserCheckpoints(controller);
    const due = (await checkpoints.listDueBrowserCheckpoints()).filter(
      (target) => target.browserSessionId === f.browserId,
    );
    expect(due).toHaveLength(1);
    expect(due[0]!.reason).toBe("idle");
    expect(await checkpoints.checkpointBrowserBeforeDeadline(due[0]!)).toEqual({
      status: "suspended",
    });
    expect(calls).toEqual({ captures: 1, cleanups: 1 });

    // The browser is asleep with a saved profile; the box is due to stop now,
    // not after a second idle window.
    current = await state(f);
    expect(current.browser.lifecycle).toBe("suspended");
    expect(current.browser.controller_generation).toBeNull();
    expect(current.browser.private_checkpoint_artifact_id).not.toBeNull();
    expect(current.holders).toEqual([]);
    expect(current.lease.liveness).toBe("draining");
    expect(current.lease.drainable).toBe(true);

    const second = await sweep();
    expect(inPlan(second, f)).toBe(true);
    const drained = await drain(f);
    expect(drained.persisted).toEqual([true]);
    expect((await state(f)).lease.liveness).toBe("cold");

    // Coming back resumes on demand. The desktop it was shown in is gone, so
    // the browser comes back as an ordinary browser instead of failing.
    const resumed = await prepareBrowserSessionResume(db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      browserSessionId: f.browserId,
      operationId: crypto.randomUUID(),
      actorSubjectId: "fixture-human",
    });
    expect(resumed.session.lifecycle).toBe("restoring");
    expect(resumed.session.linkedComputerSessionId).toBeNull();
  }, 60_000);

  test("a watched live view keeps the box warm; once it stops heartbeating the box stops", async () => {
    const f = await fixture();
    await idleFor(f, 16);
    // The live view is open and visible: its poll and 30 s heartbeat reach the
    // controller, which records use on the browser and its holder.
    expect(
      await touchBrowserSessionController(db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        browserSessionId: f.browserId,
        controllerGeneration: f.browserGeneration,
      }),
    ).toBe(true);
    const watched = await sweep();
    expect(inPlan(watched, f)).toBe(false);
    let current = await state(f);
    // All or nothing: the desktop on the same box is not released either.
    expect(current.computer).toEqual({ lifecycle: "active", failure_code: null });
    expect(current.browser.lifecycle).toBe("active");
    expect(current.holders).toHaveLength(2);
    expect(current.lease.liveness).toBe("warm");

    // The tab was hidden or closed: no heartbeat reaches the controller, so
    // after the idle timeout the box is released.
    await idleFor(f, 16);
    await sweep();
    current = await state(f);
    expect(current.browser.lifecycle).toBe("suspending");
    expect(current.computer.lifecycle).toBe("lost");
  }, 60_000);

  test("a desktop in use keeps the browser on the same box", async () => {
    const f = await fixture();
    await idleFor(f, 16);
    await admin`update computer_sessions set last_used_at = now() - interval '2 minutes'
      where id = ${f.computerId}`;
    await sweep();
    const current = await state(f);
    expect(current.browser.lifecycle).toBe("active");
    expect(current.computer.lifecycle).toBe("active");
    expect(current.lease.liveness).toBe("warm");
  }, 60_000);

  test("an open turn keeps idle browsers and desktops", async () => {
    const f = await fixture({ turnOpen: true });
    await idleFor(f, 16);
    await sweep();
    const current = await state(f);
    expect(current.browser.lifecycle).toBe("active");
    expect(current.computer.lifecycle).toBe("active");
    expect(current.holders).toHaveLength(2);
    expect(current.lease.liveness).toBe("warm");
  }, 60_000);

  test("not yet idle for the whole timeout: nothing is released", async () => {
    const f = await fixture();
    await idleFor(f, 14);
    await sweep();
    const current = await state(f);
    expect(current.browser.lifecycle).toBe("active");
    expect(current.computer.lifecycle).toBe("active");
    expect(current.lease.liveness).toBe("warm");
  }, 60_000);

  test("a failed idle save releases the browser without a second attempt", async () => {
    const f = await fixture();
    await idleFor(f, 16);
    await sweep();
    let captures = 0;
    const checkpoints = browserCheckpoints({
      captureState: async () => {
        captures++;
        throw new BrowserControlRequestError(409, {
          code: "unsupported",
          message: "synthetic capture refusal",
          retryable: false,
        });
      },
      endSession: async () => undefined,
    });
    const [target] = (await checkpoints.listDueBrowserCheckpoints()).filter(
      (due) => due.browserSessionId === f.browserId,
    );
    await expect(checkpoints.checkpointBrowserBeforeDeadline(target!)).rejects.toThrow(
      "synthetic capture refusal",
    );
    expect((await state(f)).browser.lifecycle).toBe("active");
    expect(
      (await checkpoints.listDueBrowserCheckpoints()).filter(
        (due) => due.browserSessionId === f.browserId,
      ),
    ).toEqual([]);

    // Still unused: the next idle decision releases it without saving.
    await idleFor(f, 16);
    const next = await sweep();
    expect(inPlan(next, f)).toBe(true);
    const current = await state(f);
    expect(current.browser).toMatchObject({ lifecycle: "lost", failure_code: "idle_released" });
    expect(current.holders).toEqual([]);
    expect(current.lease.liveness).toBe("draining");
    expect(captures).toBe(1);
    expect((await drain(f)).persisted).toEqual([true]);
    expect((await state(f)).lease.liveness).toBe("cold");
  }, 60_000);

  test("without browser saving, the browser is released and the box drains in the same sweep", async () => {
    const f = await fixture();
    await idleFor(f, 16);
    const plan = await sweep(null);
    expect(inPlan(plan, f)).toBe(true);
    const current = await state(f);
    expect(current.browser).toMatchObject({ lifecycle: "lost", failure_code: "idle_released" });
    expect(current.computer).toEqual({ lifecycle: "lost", failure_code: "idle_released" });
    expect(current.holders).toEqual([]);
    expect(current.lease.drainable).toBe(true);
    expect((await drain(f)).persisted).toEqual([true]);
    expect((await state(f)).lease.liveness).toBe("cold");
  }, 60_000);

  test("a browser that cannot be saved is released like a desktop", async () => {
    const f = await fixture({ checkpoint: false, linked: false });
    await idleFor(f, 16);
    const plan = await sweep();
    expect(inPlan(plan, f)).toBe(true);
    expect((await state(f)).browser).toMatchObject({
      lifecycle: "lost",
      failure_code: "idle_released",
    });
  }, 60_000);

  test("the provider-deadline operation id is byte-identical to migration 0564", async () => {
    const parts = {
      account: crypto.randomUUID(),
      workspace: crypto.randomUUID(),
      lease: crypto.randomUUID(),
      browser: crypto.randomUUID(),
      generation: crypto.randomUUID(),
    };
    // 0564: sha256 of jsonb_build_array(tag, account, workspace, lease, epoch,
    // instance, browser text, generation)::text, folded into a v4-shaped uuid.
    const jsonbText = `[${[
      "browser-provider-deadline.v1",
      parts.account,
      parts.workspace,
      parts.lease,
      EPOCH,
      "box-1",
      parts.browser,
      parts.generation,
    ]
      .map((value) => JSON.stringify(value))
      .join(", ")}]`;
    const digest = createHash("sha256").update(jsonbText, "utf8").digest("hex");
    const expected = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const [row] = await admin<{ id: string; idle: string }[]>`
      select opengeni_private.browser_system_checkpoint_operation_id(
          opengeni_private.browser_system_checkpoint_digest('provider_deadline',
            ${parts.account}::uuid, ${parts.workspace}::uuid, ${parts.lease}::uuid,
            ${EPOCH}::bigint, 'box-1', ${parts.browser}, ${parts.generation}))::text as id,
        opengeni_private.browser_system_checkpoint_operation_id(
          opengeni_private.browser_system_checkpoint_digest('idle',
            ${parts.account}::uuid, ${parts.workspace}::uuid, ${parts.lease}::uuid,
            ${EPOCH}::bigint, 'box-1', ${parts.browser}, ${parts.generation}))::text as idle`;
    expect(row!.id).toBe(expected);
    expect(row!.idle).not.toBe(expected);
  }, 60_000);

  test("an older worker that strips the idle reason cannot act on an idle save", async () => {
    const f = await fixture();
    await idleFor(f, 16);
    await sweep();
    const { controller, calls } = savingController();
    const checkpoints = browserCheckpoints(controller);
    const [target] = (await checkpoints.listDueBrowserCheckpoints()).filter(
      (due) => due.browserSessionId === f.browserId,
    );
    const { reason: _reason, ...stripped } = target!;
    expect(
      await browserDeadlineCheckpoint(db, stripped, { prepare: true, touch: true }),
    ).toBeNull();
    expect(await checkpoints.checkpointBrowserBeforeDeadline(stripped)).toEqual({
      status: "skipped",
    });
    expect(calls).toEqual({ captures: 0, cleanups: 0 });
    // An idle save is prepared only by the tenant-scoped reaper decision.
    const fresh = await fixture();
    await idleFor(fresh, 16);
    const [lease] = await admin<{ id: string }[]>`
      select id from sandbox_leases where id = ${fresh.leaseId}`;
    expect(
      await browserDeadlineCheckpoint(
        db,
        {
          accountId: fresh.accountId,
          workspaceId: fresh.workspaceId,
          sandboxGroupId: fresh.sandboxGroupId,
          leaseId: lease!.id,
          leaseEpoch: EPOCH,
          instanceId: fresh.instanceId,
          browserSessionId: fresh.browserId,
          controllerGeneration: fresh.browserGeneration,
          reason: "idle",
          idleMs: IDLE_MS,
        },
        { prepare: true },
      ),
    ).toBeNull();
    expect((await state(fresh)).browser.lifecycle).toBe("active");
  }, 60_000);

  test("the saved browser keeps its holder until cleanup, and resumes if the box goes first", async () => {
    const f = await fixture();
    await idleFor(f, 16);
    await sweep();
    let cleanupFails = true;
    const checkpoints = browserCheckpoints({
      captureState: async (input) => receipt(input),
      endSession: async () => {
        if (cleanupFails) throw new Error("synthetic cleanup failure");
      },
    });
    const [target] = (await checkpoints.listDueBrowserCheckpoints()).filter(
      (due) => due.browserSessionId === f.browserId,
    );
    await expect(checkpoints.checkpointBrowserBeforeDeadline(target!)).rejects.toThrow(
      "synthetic cleanup failure",
    );
    let current = await state(f);
    expect(current.browser.lifecycle).toBe("suspended");
    expect(current.browser.controller_generation).not.toBeNull();
    // The orphan sweep keeps the exact saved generation's holder for cleanup.
    await sweep();
    current = await state(f);
    expect(current.holders).toEqual([`browser-session:${f.browserId}`]);
    expect(current.lease.liveness).toBe("warm");

    // The box is replaced before cleanup could run: the holder is an orphan,
    // and only the stale controller binding is cleared so the profile resumes.
    await admin`update sandbox_leases set lease_epoch = lease_epoch + 1 where id = ${f.leaseId}`;
    await sweep();
    current = await state(f);
    expect(current.holders).toEqual([]);
    expect(current.browser.lifecycle).toBe("suspended");
    expect(current.browser.controller_generation).toBeNull();
    expect(current.browser.private_checkpoint_artifact_id).not.toBeNull();
    cleanupFails = false;
    const resumed = await prepareBrowserSessionResume(db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      browserSessionId: f.browserId,
      operationId: crypto.randomUUID(),
      actorSubjectId: "fixture-human",
    });
    expect(resumed.session.lifecycle).toBe("restoring");
  }, 60_000);

  test("an idle save's cleanup keeps the containment clock of a box with retained commands", async () => {
    const f = await fixture();
    await idleFor(f, 16);
    await sweep();
    // A viewer holder that outlives the browser keeps the box warm, as a
    // retained command's holder would.
    await admin`insert into sandbox_lease_holders (account_id, workspace_id, lease_id, kind,
        holder_id, last_heartbeat_at)
      values (${f.accountId}, ${f.workspaceId}, ${f.leaseId}, 'viewer', 'viewer:fixture', now())`;
    await admin`update sandbox_leases set refcount = refcount + 1,
      viewer_holders = viewer_holders + 1 where id = ${f.leaseId}`;
    await admin`update sandbox_leases set holders_changed_at = now() - interval '40 minutes'
      where id = ${f.leaseId}`;
    const { controller } = savingController();
    const checkpoints = browserCheckpoints(controller);
    const [target] = (await checkpoints.listDueBrowserCheckpoints()).filter(
      (due) => due.browserSessionId === f.browserId,
    );
    expect(await checkpoints.checkpointBrowserBeforeDeadline(target!)).toEqual({
      status: "suspended",
    });
    const [lease] = await admin<{ liveness: string; old: boolean }[]>`
      select liveness, holders_changed_at < now() - interval '39 minutes' as old
      from sandbox_leases where id = ${f.leaseId}`;
    expect(lease).toEqual({ liveness: "warm", old: true });
  }, 60_000);
});
