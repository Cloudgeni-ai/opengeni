import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  testSettings,
  MemoryEventBus,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  AgentEvent,
  AgentUpdateStage,
  ControlRequest,
  ControlResponse,
  GoingOfflineReason,
  Hello,
} from "@opengeni/agent-proto";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  claimEnrollmentConnection,
  beginEnrollmentAgentUpdate,
  createDb,
  createEnrollment,
  createSandbox,
  createSession,
  getEnrollment,
  listSandboxes,
  revokeEnrollment,
  setActiveSandbox,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { subjectFor } from "@opengeni/runtime";
import { createApp } from "../src/app";
import type { AppDependencies, SessionWorkflowClient } from "@opengeni/core";
import {
  handleAgentEventPayload,
  handleHelloPayload,
  startMetricsIngestion,
} from "../src/sandbox/metrics-ingestion";

// Track started ingestion consumers so afterEach can unsubscribe them (each test
// uses its own bus, but cleaning up keeps subscriptions from leaking).
const ingestionStoppers: Array<() => void> = [];

// M10 — the Machines DASHBOARD + per-machine metrics-series ROUTES, driven
// end-to-end through createApp + the REAL packages/db on a THROWAWAY postgres
// (mirrors enrollment-routes / fleet-tools). The selfhosted control plane is an
// in-memory MemoryEventBus responder (ping → online) + the same bus drives the
// metrics-INGESTION consumer via emitAgentEvent (a heartbeat AgentEvent), so the
// machines endpoint returns the contract shape across states with REAL metrics.
//
// Proves:
//   - GET /machines: the workspace's enrolled selfhosted machine (online, with
//     latest metrics + sharedSessionCount) and, with ?sessionId, the synthetic
//     Modal group entry (isSessionGroup:true) + the active pointer.
//   - state matrix: online (consent + display) vs consent_required vs offline.
//   - metrics ingestion → the latest row surfaces in the response.
//   - GET /metrics/series: the downsampled series.
//   - flag OFF → 404; cross-workspace bearer → 403; unknown machine series → 404.

const DELEGATION_SECRET = "m10-delegation-secret";
const CONNECTION_INSTANCE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

const settings = testSettings({
  productAccessMode: "managed",
  authRequired: false,
  delegationSecret: DELEGATION_SECRET,
  sandboxSelfhostedEnabled: true,
  selfhostedRelayUrl: "wss://relay.example",
});

/** A MemoryEventBus whose responder answers ping → online for the agent subject
 *  (online=false registers no responder → offline). */
function busWithAgent(opts: {
  workspaceId: string;
  agentId: string;
  online: boolean;
  onRequest?: (request: ControlRequest) => void;
}): MemoryEventBus {
  const bus = new MemoryEventBus();
  if (!opts.online) {
    return bus;
  }
  bus.subscribeRequests(
    subjectFor(opts.workspaceId, opts.agentId, CONNECTION_INSTANCE_ID),
    (payload) => {
      const req = ControlRequest.decode(payload);
      opts.onRequest?.(req);
      const op = req.op;
      const res: ControlResponse =
        op?.$case === "ping"
          ? {
              requestId: req.requestId,
              result: { $case: "ping", ping: { nonce: op.ping.nonce, agentMonotonicMs: "0" } },
            }
          : op?.$case === "agentUpdateApply"
            ? {
                requestId: req.requestId,
                result: {
                  $case: "agentUpdateApply",
                  agentUpdateApply: {
                    accepted: true,
                    operationId: op.agentUpdateApply.operationId,
                    currentVersion: op.agentUpdateApply.expectedCurrentVersion,
                    currentSha256: op.agentUpdateApply.expectedCurrentSha256,
                    targetVersion: op.agentUpdateApply.targetVersion,
                  },
                },
              }
            : {
                requestId: req.requestId,
                error: { code: 0, message: "unsupported", retryable: false, detail: {} },
              };
      return ControlResponse.encode(res).finish();
    },
  );
  return bus;
}

async function claimConnection(workspaceId: string, enrollmentId: string): Promise<void> {
  const claimed = await claimEnrollmentConnection(db, {
    workspaceId,
    enrollmentId,
    credentialGeneration: 1,
    connectionInstanceId: CONNECTION_INSTANCE_ID,
    leaseMs: 20_000,
  });
  expect(claimed.claimed).toBe(true);
}

class SlowProbeBus extends MemoryEventBus {
  startedSubjects: string[] = [];
  completed = 0;
  maxInFlight = 0;
  private inFlight = 0;

  constructor(private readonly delayMs: number) {
    super();
  }

  getRequestConnection(): ReturnType<MemoryEventBus["getRequestConnection"]> {
    return {
      request: async (subject, payload) => {
        this.startedSubjects.push(subject);
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        const { requestId } = ControlRequest.decode(payload);
        await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
        this.inFlight -= 1;
        this.completed += 1;
        return {
          data: ControlResponse.encode({
            requestId,
            error: {
              code: 4,
              message: "probe timed out",
              retryable: true,
              detail: {},
            },
          }).finish(),
        };
      },
    };
  }
}

/** Build + emit a heartbeat AgentEvent carrying a metrics sample, driving the
 *  in-process ingestion consumer (started by createApp). */
async function emitHeartbeat(
  bus: MemoryEventBus,
  workspaceId: string,
  agentId: string,
  cpuPct: number,
): Promise<void> {
  // A reconnect claims authority before publishing its first heartbeat. Repeating
  // the same instance is a lease renewal; after GoingOffline it is a new claim.
  await claimConnection(workspaceId, agentId);
  const event = AgentEvent.encode({
    agentId,
    event: {
      $case: "heartbeat",
      heartbeat: {
        seq: "1",
        uptimeMs: "1000",
        activeSessions: 0,
        draining: false,
        metrics: {
          sampledAtMs: String(Date.now()),
          cpuPercent: cpuPct,
          load1: 0.5,
          load5: 0.4,
          load15: 0.3,
          memUsedBytes: "1024",
          memTotalBytes: "4096",
          diskUsedBytes: "2048",
          diskTotalBytes: "8192",
          runQueue: 1,
          gpus: [],
        },
      },
    },
  }).finish();
  await bus.emitAgentEvent(
    `agent.${workspaceId}.${agentId}.connection.${CONNECTION_INSTANCE_ID}.events`,
    event,
  );
}

async function emitHeartbeatWithoutMetrics(
  bus: MemoryEventBus,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  const event = AgentEvent.encode({
    agentId,
    event: {
      $case: "heartbeat",
      heartbeat: {
        seq: "2",
        uptimeMs: "2000",
        activeSessions: 0,
        draining: false,
      },
    },
  }).finish();
  await bus.emitAgentEvent(
    `agent.${workspaceId}.${agentId}.connection.${CONNECTION_INSTANCE_ID}.events`,
    event,
  );
}

/** Emit a clean GoingOffline AgentEvent, driving the ingestion consumer to stamp
 *  the enrollment's clean going-offline marker. */
async function emitGoingOffline(
  bus: MemoryEventBus,
  workspaceId: string,
  agentId: string,
  reason: GoingOfflineReason,
): Promise<void> {
  const event = AgentEvent.encode({
    agentId,
    event: { $case: "goingOffline", goingOffline: { reason } },
  }).finish();
  await bus.emitAgentEvent(
    `agent.${workspaceId}.${agentId}.connection.${CONNECTION_INSTANCE_ID}.events`,
    event,
  );
}

function appFor(bus: MemoryEventBus, overrides: Partial<AppDependencies> = {}) {
  const noop = async () => {};
  const workflowClient = {
    signalUserMessage: noop,
    wakeSessionWorkflow: noop,
    signalApprovalDecision: noop,
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
  const deps: AppDependencies = {
    settings,
    db,
    bus: bus as never,
    workflowClient,
    managedAuth: null,
    ...overrides,
  };
  // Mirror startApi: start the metrics-ingestion consumer when the flag is on, so
  // emitHeartbeat actually lands rows (the route test exercises ingestion + read).
  const effectiveSettings = overrides.settings ?? settings;
  if (effectiveSettings.sandboxSelfhostedEnabled) {
    ingestionStoppers.push(startMetricsIngestion({ db, bus, observability: undefined }));
  }
  return createApp(deps);
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

async function seedCrossWorkspaceScopedMachine(scope: "organization" | "user") {
  const { accountId, workspaceId: originWorkspaceId } = await freshWorkspace();
  const [target] = await admin<Array<{ id: string }>>`
    insert into workspaces (account_id, name) values (${accountId}, ${`${scope} target`}) returning id
  `;
  const targetWorkspaceId = target!.id;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${targetWorkspaceId}, ${accountId})
  `;
  await admin`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id, authorization_revision
    ) values (${accountId}, 'user-m10', 'active', ${originWorkspaceId}, 1)
  `;
  await admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id) values
      (${accountId}, ${originWorkspaceId}, 'user-m10'),
      (${accountId}, ${targetWorkspaceId}, 'user-m10')
  `;
  const machine = await admin.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${originWorkspaceId}, true),
      set_config('opengeni.subject_id', 'user-m10', true),
      set_config('opengeni.initiating_human_subject_id', 'user-m10', true)`;
    const [row] = await tx<Array<{ enrollmentId: string }>>`
      select enrollment_id as "enrollmentId"
      from finalize_scoped_enrollment(
        ${accountId}::uuid, ${originWorkspaceId}::uuid, ${scope},
        ${`ed25519:${crypto.randomUUID()}`}, true, true, 'linux', 'x86_64',
        ${`${scope} machine`}, ${scope === "organization"}
      )
    `;
    return row!;
  });
  await admin`update enrollments set last_seen_at = now() where id = ${machine.enrollmentId}`;
  await claimConnection(originWorkspaceId, machine.enrollmentId);
  return { accountId, originWorkspaceId, targetWorkspaceId, enrollmentId: machine.enrollmentId };
}

async function bearer(
  accountId: string,
  workspaceId: string,
  permissions: Permission[],
): Promise<string> {
  return await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId: "user-m10",
    subjectLabel: "M10 User",
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("machines-routes");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[machines-routes] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterEach(() => {
  while (ingestionStoppers.length > 0) {
    ingestionStoppers.pop()?.();
  }
});

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

type SeedOpts = {
  online?: boolean;
  hasDisplay?: boolean;
  allowScreenControl?: boolean;
  sandboxBackend?: "modal" | "none";
};
async function seed(opts: SeedOpts = {}) {
  const { accountId, workspaceId } = await freshWorkspace();
  const session = await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "hi",
    resources: [],
    metadata: {},
    model: "gpt-test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: opts.sandboxBackend ?? "modal",
  });
  const enrollment = await createEnrollment(db, {
    accountId,
    workspaceId,
    pubkey: `ed25519:${crypto.randomUUID()}`,
    exposure: "whole-machine",
    hasDisplay: opts.hasDisplay ?? true,
    allowScreenControl: opts.allowScreenControl ?? true,
    os: "linux",
    arch: "x86_64",
  });
  await admin`update enrollments set last_seen_at = now() where id = ${enrollment.id}`;
  const sandbox = await createSandbox(db, {
    accountId,
    workspaceId,
    kind: "selfhosted",
    name: "my-laptop",
    enrollmentId: enrollment.id,
  });
  if (opts.online ?? true) {
    await claimConnection(workspaceId, enrollment.id);
  }
  const bus = busWithAgent({ workspaceId, agentId: enrollment.id, online: opts.online ?? true });
  return { accountId, workspaceId, session, enrollment, sandbox, bus };
}

describe("M10 GET /machines — dashboard list + states + metrics", () => {
  test("a backend:none session exposes its machine fleet without a synthetic home", async () => {
    if (!available) return;
    const { accountId, workspaceId, session, sandbox, bus } = await seed({
      sandboxBackend: "none",
    });
    const app = appFor(bus);
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;

    const response = await app.request(
      `/v1/workspaces/${workspaceId}/machines?sessionId=${session.id}`,
      { headers: { authorization: auth } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      activeSandboxId: string | null;
      machines: Array<{ sandboxId: string; active: boolean; isSessionGroup: boolean }>;
    };
    expect(body.activeSandboxId).toBeNull();
    expect(body.machines).toEqual([
      expect.objectContaining({ sandboxId: sandbox.id, active: false, isSessionGroup: false }),
    ]);
  }, 60_000);

  test("an online machine returns the contract shape with latest metrics; ?sessionId adds the synthetic group + active pointer", async () => {
    if (!available) return;
    const { accountId, workspaceId, session, enrollment, sandbox, bus } = await seed();
    const app = appFor(bus);
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;

    // Drive a heartbeat → the ingestion consumer upserts the latest metrics row.
    await emitHeartbeat(bus, workspaceId, enrollment.id, 42.5);
    // A second valid daemon is denied and that safety event remains visible in
    // the ordinary inventory without exposing either process id.
    const duplicate = await claimEnrollmentConnection(db, {
      workspaceId,
      enrollmentId: enrollment.id,
      credentialGeneration: enrollment.credentialGeneration,
      connectionInstanceId: crypto.randomUUID(),
      leaseMs: 20_000,
    });
    expect(duplicate.claimed).toBe(false);

    // Workspace dashboard (no session): just the enrolled machine, null active.
    const wsRes = await app.request(`/v1/workspaces/${workspaceId}/machines`, {
      headers: { authorization: auth },
    });
    expect(wsRes.status).toBe(200);
    const wsBody = (await wsRes.json()) as {
      activeSandboxId: string | null;
      activeEpoch: number;
      machines: Array<{
        sandboxId: string;
        isSessionGroup: boolean;
        kind: string;
        state: string;
        metrics: { cpuPct: number } | null;
        sharedSessionCount: number;
        hasDisplay: boolean;
        allowScreenControl: boolean;
        connectionAuthority: {
          state: string;
          generation: number;
          supersededCount: number;
          duplicateRunnerDeniedCount: number;
        };
      }>;
    };
    expect(wsBody.activeSandboxId).toBeNull();
    expect(wsBody.activeEpoch).toBe(0);
    expect(wsBody.machines.length).toBe(1);
    const machine = wsBody.machines[0]!;
    expect(machine.sandboxId).toBe(sandbox.id);
    expect(machine.isSessionGroup).toBe(false);
    expect(machine.kind).toBe("selfhosted");
    expect(machine.state).toBe("online"); // consent acked + display present
    expect(machine.hasDisplay).toBe(true);
    expect(machine.allowScreenControl).toBe(true);
    expect(machine.connectionAuthority).toEqual({
      state: "active",
      generation: 1,
      supersededCount: 0,
      leaseExpiresAt: expect.any(String),
      duplicateRunnerDeniedCount: 1,
      duplicateRunnerDeniedAt: expect.any(String),
    });
    expect(machine.metrics).not.toBeNull();
    expect(machine.metrics!.cpuPct).toBe(42.5);

    // In-session view: the synthetic Modal group box is prepended.
    const sessRes = await app.request(
      `/v1/workspaces/${workspaceId}/machines?sessionId=${session.id}`,
      { headers: { authorization: auth } },
    );
    expect(sessRes.status).toBe(200);
    const sessBody = (await sessRes.json()) as {
      machines: Array<{
        isSessionGroup: boolean;
        kind: string;
        active: boolean;
        sandboxId: string;
      }>;
    };
    const group = sessBody.machines.find((m) => m.isSessionGroup);
    expect(group).toBeDefined();
    expect(group!.kind).toBe("modal");
    expect(group!.active).toBe(true); // null active pointer == the group box
    expect(group!.sandboxId).toBe(session.sandboxGroupId);
    // Both the group box + the enrolled machine are present.
    expect(sessBody.machines.length).toBe(2);
  }, 90_000);

  test("clean going-offline round-trip: online → GoingOffline reads OFFLINE immediately (probe still responds) → heartbeat reads ONLINE again", async () => {
    if (!available) return;
    // seed() stamps a fresh last_seen, so WITHOUT a marker the list reads online.
    // This proves the goodbye marker takes precedence over a still-fresh heartbeat
    // — the #348 fix — through the real ingestion consumer + list derivation.
    const { accountId, workspaceId, enrollment, bus } = await seed();
    const app = appFor(bus);
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
    const stateNow = async (): Promise<string> => {
      const body = (await (
        await app.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: auth },
        })
      ).json()) as { machines: Array<{ state: string }> };
      return body.machines[0]!.state;
    };

    // 1. Online: last_seen fresh (list is heartbeat-only; no live ping).
    await emitHeartbeat(bus, workspaceId, enrollment.id, 10);
    expect(await stateNow()).toBe("online");

    // 2. Clean GoingOffline → OFFLINE immediately, even though last_seen is
    //    still fresh (the marker wins).
    await emitGoingOffline(
      bus,
      workspaceId,
      enrollment.id,
      GoingOfflineReason.GOING_OFFLINE_REASON_HOST_SHUTDOWN,
    );
    expect(await stateNow()).toBe("offline");

    // 3. A fresh heartbeat clears the marker → ONLINE again (round-trip complete).
    await emitHeartbeat(bus, workspaceId, enrollment.id, 12);
    expect(await stateNow()).toBe("online");
  }, 90_000);

  test("a heartbeat renews runner authority even when optional metrics are absent", async () => {
    if (!available) return;
    const { workspaceId, enrollment, bus } = await seed();
    appFor(bus);
    await admin`update enrollments set last_seen_at = null where id = ${enrollment.id}`;

    await emitHeartbeatWithoutMetrics(bus, workspaceId, enrollment.id);

    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.connectionInstanceId).toBe(CONNECTION_INSTANCE_ID);
    expect(after?.connectionLeaseExpiresAt).not.toBeNull();
    expect(after?.lastSeenAt).not.toBeNull();
  }, 90_000);

  test("state matrix: displayed-but-unconsented is ONLINE (view/control decoupled); offline when last_seen is missing", async () => {
    if (!available) return;
    // A displayed machine whose SCREEN CONTROL isn't consented is still ONLINE:
    // compute + read-only viewing work; only INPUT is withheld (surfaced via the
    // separate allowScreenControl field, not by degrading the machine state).
    {
      const { accountId, workspaceId, bus } = await seed({
        allowScreenControl: false,
        hasDisplay: true,
      });
      const app = appFor(bus);
      const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
      const body = (await (
        await app.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: auth },
        })
      ).json()) as { machines: Array<{ state: string; allowScreenControl: boolean }> };
      expect(body.machines[0]!.state).toBe("online");
      expect(body.machines[0]!.allowScreenControl).toBe(false);
    }
    // offline: list has no live ping; a missing lastSeenAt is hard-offline.
    {
      const { accountId, workspaceId, enrollment, bus } = await seed({ online: false });
      await admin`update enrollments set last_seen_at = null where id = ${enrollment.id}`;
      const app = appFor(bus);
      const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
      const body = (await (
        await app.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: auth },
        })
      ).json()) as { machines: Array<{ state: string; metrics: unknown }> };
      expect(body.machines[0]!.state).toBe("offline");
    }
    // display_unavailable: online + consented but headless (no display).
    {
      const { accountId, workspaceId, bus } = await seed({
        hasDisplay: false,
        allowScreenControl: true,
      });
      const app = appFor(bus);
      const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
      const body = (await (
        await app.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: auth },
        })
      ).json()) as { machines: Array<{ state: string }> };
      expect(body.machines[0]!.state).toBe("display_unavailable");
    }
  }, 120_000);

  test("lists enrolled machines from durable state without a ControlRpc probe", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enrollments = [];
    for (let i = 0; i < 4; i += 1) {
      const enrollment = await createEnrollment(db, {
        accountId,
        workspaceId,
        pubkey: `ed25519:${crypto.randomUUID()}`,
        exposure: "whole-machine",
        hasDisplay: true,
        allowScreenControl: true,
        os: "linux",
        arch: "x86_64",
      });
      enrollments.push(enrollment);
      await admin`update enrollments set last_seen_at = now() where id = ${enrollment.id}`;
      await claimConnection(workspaceId, enrollment.id);
      await createSandbox(db, {
        accountId,
        workspaceId,
        kind: "selfhosted",
        name: `machine-${i}`,
        enrollmentId: enrollment.id,
      });
    }
    await revokeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollments[3]!.id,
    });

    const expectedOrder = (await listSandboxes(db, workspaceId))
      .filter((sandbox) => sandbox.enrollmentId !== enrollments[3]!.id)
      .map((sandbox) => sandbox.id);
    const bus = new SlowProbeBus(150);
    const app = appFor(bus);
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;

    const res = await app.request(`/v1/workspaces/${workspaceId}/machines`, {
      headers: { authorization: auth },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { machines: Array<{ sandboxId: string }> };
    expect(body.machines.map((machine) => machine.sandboxId)).toEqual(expectedOrder);
    expect(bus.startedSubjects).toEqual([]);
    expect(bus.completed).toBe(0);
    expect(bus.maxInFlight).toBe(0);
  }, 30_000);
});

describe("M10 GET /machines/:enrollmentId/metrics/series", () => {
  test("returns the downsampled series after heartbeats; unknown machine → 404", async () => {
    if (!available) return;
    const { accountId, workspaceId, enrollment, bus } = await seed();
    const app = appFor(bus);
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;

    // Two heartbeats: the first seeds a series row; the dashboard reads it back.
    await emitHeartbeat(bus, workspaceId, enrollment.id, 11);

    const res = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/metrics/series?window=1h`,
      { headers: { authorization: auth } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { samples: Array<{ cpuPct: number; sampledAt: string }> };
    expect(body.samples.length).toBeGreaterThanOrEqual(1);
    expect(body.samples[0]!.cpuPct).toBe(11);

    // Unknown machine id → 404 (not an empty series).
    const unknown = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${crypto.randomUUID()}/metrics/series`,
      { headers: { authorization: auth } },
    );
    expect(unknown.status).toBe(404);
  }, 90_000);
});

describe("Connected Machine command policy", () => {
  test("organization policy mutation requires account admin while personal ownership does not", async () => {
    if (!available) return;
    const policy = {
      memoryMaxBytes: 536_870_912,
      memoryHighBytes: null,
      cpuMaxMillicores: 1_000,
      expectedRevision: 0,
    };
    const patchPolicy = async (
      machine: Awaited<ReturnType<typeof seedCrossWorkspaceScopedMachine>>,
      permissions: Permission[],
    ) =>
      await appFor(new MemoryEventBus()).request(
        `/v1/workspaces/${machine.targetWorkspaceId}/machines/${machine.enrollmentId}/operation-policy`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${await bearer(
              machine.accountId,
              machine.targetWorkspaceId,
              permissions,
            )}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(policy),
        },
      );

    const organization = await seedCrossWorkspaceScopedMachine("organization");
    expect((await patchPolicy(organization, ["workspace:admin"])).status).toBe(403);
    expect(
      (await getEnrollment(db, organization.originWorkspaceId, organization.enrollmentId))
        ?.operationPolicy.revision,
    ).toBe(0);
    expect((await patchPolicy(organization, ["enrollments:manage", "account:admin"])).status).toBe(
      200,
    );

    const personal = await seedCrossWorkspaceScopedMachine("user");
    expect((await patchPolicy(personal, ["enrollments:manage"])).status).toBe(200);
  }, 90_000);

  test("updates exact memory and CPU limits under a revision fence and projects them", async () => {
    if (!available) return;
    const { accountId, workspaceId, enrollment } = await seed();
    const app = appFor(new MemoryEventBus());
    const manageAuth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage"])}`;

    const updated = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/operation-policy`,
      {
        method: "PATCH",
        headers: { authorization: manageAuth, "content-type": "application/json" },
        body: JSON.stringify({
          memoryMaxBytes: 1_073_741_824,
          memoryHighBytes: 805_306_368,
          cpuMaxMillicores: 1_500,
          expectedRevision: 0,
        }),
      },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      memoryMaxBytes: 1_073_741_824,
      memoryHighBytes: 805_306_368,
      cpuMaxMillicores: 1_500,
      revision: 1,
    });

    const legacyMemoryOnly = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/operation-policy`,
      {
        method: "PATCH",
        headers: { authorization: manageAuth, "content-type": "application/json" },
        body: JSON.stringify({
          memoryMaxBytes: 536_870_912,
          memoryHighBytes: null,
          expectedRevision: 1,
        }),
      },
    );
    expect(legacyMemoryOnly.status).toBe(200);
    expect(await legacyMemoryOnly.json()).toMatchObject({
      memoryMaxBytes: 536_870_912,
      cpuMaxMillicores: 1_500,
      revision: 2,
    });

    const stale = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/operation-policy`,
      {
        method: "PATCH",
        headers: { authorization: manageAuth, "content-type": "application/json" },
        body: JSON.stringify({
          memoryMaxBytes: null,
          memoryHighBytes: null,
          cpuMaxMillicores: null,
          expectedRevision: 0,
        }),
      },
    );
    expect(stale.status).toBe(409);

    const readAuth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
    const listed = await app.request(`/v1/workspaces/${workspaceId}/machines`, {
      headers: { authorization: readAuth },
    });
    expect(listed.status).toBe(200);
    const fleet = (await listed.json()) as {
      machines: Array<{
        enrollmentId: string | null;
        operationPolicy: {
          memoryMaxBytes: number | null;
          cpuMaxMillicores: number | null;
          revision: number;
        } | null;
      }>;
    };
    expect(
      fleet.machines.find((machine) => machine.enrollmentId === enrollment.id)?.operationPolicy,
    ).toMatchObject({ memoryMaxBytes: 536_870_912, cpuMaxMillicores: 1_500, revision: 2 });
  }, 90_000);

  test("requires manage permission and rejects invalid resource values", async () => {
    if (!available) return;
    const { accountId, workspaceId, enrollment } = await seed();
    const app = appFor(new MemoryEventBus());
    const readAuth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
    const denied = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/operation-policy`,
      {
        method: "PATCH",
        headers: { authorization: readAuth, "content-type": "application/json" },
        body: JSON.stringify({
          memoryMaxBytes: null,
          memoryHighBytes: null,
          cpuMaxMillicores: null,
          expectedRevision: 0,
        }),
      },
    );
    expect(denied.status).toBe(403);

    const manageAuth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage"])}`;
    const invalid = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/operation-policy`,
      {
        method: "PATCH",
        headers: { authorization: manageAuth, "content-type": "application/json" },
        body: JSON.stringify({
          memoryMaxBytes: 1024,
          memoryHighBytes: 2048,
          cpuMaxMillicores: null,
          expectedRevision: 0,
        }),
      },
    );
    expect(invalid.status).toBe(400);

    const invalidCpu = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/operation-policy`,
      {
        method: "PATCH",
        headers: { authorization: manageAuth, "content-type": "application/json" },
        body: JSON.stringify({
          memoryMaxBytes: null,
          memoryHighBytes: null,
          cpuMaxMillicores: 0,
          expectedRevision: 0,
        }),
      },
    );
    expect(invalidCpu.status).toBe(400);
  }, 90_000);
});

describe("Connected Machine signed self-update orchestration", () => {
  test("organization update requires account admin before any runner dispatch", async () => {
    if (!available) return;
    const machine = await seedCrossWorkspaceScopedMachine("organization");
    await handleHelloPayload(
      db,
      undefined,
      Hello.encode(
        Hello.fromPartial({
          agentId: machine.enrollmentId,
          workspaceId: machine.originWorkspaceId,
          agentVersion: "0.1.15",
          binarySha256: "ab".repeat(32),
          updateChannel: "stable",
        }),
      ).finish(),
      `agent.${machine.originWorkspaceId}.${machine.enrollmentId}.connection.${CONNECTION_INSTANCE_ID}.hello`,
    );
    const requests: ControlRequest[] = [];
    const app = appFor(
      busWithAgent({
        workspaceId: machine.originWorkspaceId,
        agentId: machine.enrollmentId,
        online: true,
        onRequest: (request) => requests.push(request),
      }),
      { settings: { ...settings, agentStableVersion: "0.1.16" } },
    );
    const response = await app.request(
      `/v1/workspaces/${machine.targetWorkspaceId}/machines/${machine.enrollmentId}/update`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await bearer(machine.accountId, machine.targetWorkspaceId, [
            "workspace:admin",
          ])}`,
        },
      },
    );
    expect(response.status).toBe(403);
    expect(requests).toHaveLength(0);
  }, 90_000);

  test.each(["user", "organization"] as const)(
    "cross-workspace %s update advances and completes on the origin row",
    async (scope) => {
      if (!available) return;
      const machine = await seedCrossWorkspaceScopedMachine(scope);
      const currentDigest = "ab".repeat(32);
      const targetDigest = "cd".repeat(32);
      await handleHelloPayload(
        db,
        undefined,
        Hello.encode(
          Hello.fromPartial({
            agentId: machine.enrollmentId,
            workspaceId: machine.originWorkspaceId,
            agentVersion: "0.1.15",
            binarySha256: currentDigest,
            updateChannel: "stable",
          }),
        ).finish(),
        `agent.${machine.originWorkspaceId}.${machine.enrollmentId}.connection.${CONNECTION_INSTANCE_ID}.hello`,
      );
      const bus = busWithAgent({
        workspaceId: machine.originWorkspaceId,
        agentId: machine.enrollmentId,
        online: true,
      });
      const app = appFor(bus, {
        settings: {
          ...settings,
          agentStableVersion: "0.1.16",
          publicBaseUrl: "https://dev.opengeni.example",
        },
      });
      const permissions: Permission[] =
        scope === "organization" ? ["enrollments:manage", "account:admin"] : ["enrollments:manage"];
      const response = await app.request(
        `/v1/workspaces/${machine.targetWorkspaceId}/machines/${machine.enrollmentId}/update`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${await bearer(
              machine.accountId,
              machine.targetWorkspaceId,
              permissions,
            )}`,
          },
        },
      );
      expect(response.status).toBe(202);
      const { operationId } = (await response.json()) as { operationId: string };
      expect(
        (await getEnrollment(db, machine.originWorkspaceId, machine.enrollmentId))?.agentUpdate,
      ).toMatchObject({ operationId, status: "accepted" });

      await bus.emitAgentEvent(
        `agent.${machine.originWorkspaceId}.${machine.enrollmentId}.connection.${CONNECTION_INSTANCE_ID}.events`,
        AgentEvent.encode({
          agentId: machine.enrollmentId,
          event: {
            $case: "agentUpdateProgress",
            agentUpdateProgress: {
              operationId,
              targetVersion: "0.1.16",
              expectedBinarySha256: targetDigest,
              stage: AgentUpdateStage.AGENT_UPDATE_STAGE_RESTARTING,
              errorCode: "",
              retryable: false,
              rolledBack: false,
            },
          },
        }).finish(),
      );
      expect(
        (await getEnrollment(db, machine.originWorkspaceId, machine.enrollmentId))?.agentUpdate
          ?.status,
      ).toBe("restarting");
      await handleHelloPayload(
        db,
        undefined,
        Hello.encode(
          Hello.fromPartial({
            agentId: machine.enrollmentId,
            workspaceId: machine.originWorkspaceId,
            agentVersion: "0.1.16",
            binarySha256: targetDigest,
            completedUpdateOperationId: operationId,
            completedUpdateTargetVersion: "0.1.16",
            completedUpdateBinarySha256: targetDigest,
          }),
        ).finish(),
        `agent.${machine.originWorkspaceId}.${machine.enrollmentId}.connection.${CONNECTION_INSTANCE_ID}.hello`,
      );
      expect(
        (await getEnrollment(db, machine.originWorkspaceId, machine.enrollmentId))?.agentUpdate
          ?.status,
      ).toBe("succeeded");
    },
    90_000,
  );

  test("dispatches to the exact process and completes only after the matching successor Hello", async () => {
    if (!available) return;
    const { accountId, workspaceId, enrollment } = await seed();
    const currentDigest = "ab".repeat(32);
    const targetDigest = "cd".repeat(32);
    await handleHelloPayload(
      db,
      undefined,
      Hello.encode(
        Hello.fromPartial({
          agentId: enrollment.id,
          workspaceId,
          agentVersion: "0.1.15",
          binarySha256: currentDigest,
          updateChannel: "stable",
          capabilities: { exec: true, filesystem: true, git: true, pty: true },
        }),
      ).finish(),
      `agent.${workspaceId}.${enrollment.id}.connection.${CONNECTION_INSTANCE_ID}.hello`,
    );

    const requests: ControlRequest[] = [];
    const bus = busWithAgent({
      workspaceId,
      agentId: enrollment.id,
      online: true,
      onRequest: (request) => requests.push(request),
    });
    const app = appFor(bus, {
      settings: {
        ...settings,
        agentStableVersion: "0.1.16",
        publicBaseUrl: "https://dev.opengeni.example",
      },
    });
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage"])}`;
    const response = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/update`,
      { method: "POST", headers: { authorization: auth } },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { operationId: string; targetVersion: string };
    expect(body.targetVersion).toBe("0.1.16");
    const updateRequest = requests.find((request) => request.op?.$case === "agentUpdateApply");
    expect(updateRequest?.epoch).toBe(0);
    expect(updateRequest?.op).toEqual({
      $case: "agentUpdateApply",
      agentUpdateApply: {
        operationId: body.operationId,
        targetVersion: "0.1.16",
        channel: "stable",
        expectedCurrentVersion: "0.1.15",
        expectedCurrentSha256: currentDigest,
        releaseBaseUrl: "https://dev.opengeni.example",
      },
    });
    expect((await getEnrollment(db, workspaceId, enrollment.id))?.agentUpdate?.status).toBe(
      "accepted",
    );

    await bus.emitAgentEvent(
      `agent.${workspaceId}.${enrollment.id}.connection.${CONNECTION_INSTANCE_ID}.events`,
      AgentEvent.encode({
        agentId: enrollment.id,
        event: {
          $case: "agentUpdateProgress",
          agentUpdateProgress: {
            operationId: body.operationId,
            targetVersion: "0.1.16",
            expectedBinarySha256: targetDigest,
            stage: AgentUpdateStage.AGENT_UPDATE_STAGE_RESTARTING,
            errorCode: "",
            retryable: false,
            rolledBack: false,
          },
        },
      }).finish(),
    );
    expect((await getEnrollment(db, workspaceId, enrollment.id))?.agentUpdate?.status).toBe(
      "restarting",
    );

    // A reconnect alone is insufficient: the exact signed artifact digest is
    // part of the success proof.
    await handleHelloPayload(
      db,
      undefined,
      Hello.encode(
        Hello.fromPartial({
          agentId: enrollment.id,
          workspaceId,
          agentVersion: "0.1.16",
          binarySha256: "ef".repeat(32),
          updateChannel: "stable",
          completedUpdateOperationId: body.operationId,
          completedUpdateTargetVersion: "0.1.16",
          completedUpdateBinarySha256: targetDigest,
        }),
      ).finish(),
      `agent.${workspaceId}.${enrollment.id}.connection.${CONNECTION_INSTANCE_ID}.hello`,
    );
    expect((await getEnrollment(db, workspaceId, enrollment.id))?.agentUpdate?.status).toBe(
      "restarting",
    );
    await handleHelloPayload(
      db,
      undefined,
      Hello.encode(
        Hello.fromPartial({
          agentId: enrollment.id,
          workspaceId,
          agentVersion: "0.1.16",
          binarySha256: targetDigest,
          updateChannel: "stable",
          completedUpdateOperationId: body.operationId,
          completedUpdateTargetVersion: "0.1.16",
          completedUpdateBinarySha256: targetDigest,
        }),
      ).finish(),
      `agent.${workspaceId}.${enrollment.id}.connection.${CONNECTION_INSTANCE_ID}.hello`,
    );
    expect((await getEnrollment(db, workspaceId, enrollment.id))?.agentUpdate?.status).toBe(
      "succeeded",
    );
  }, 90_000);

  test("redelivers one unconfirmed operation id instead of reserving a second update", async () => {
    if (!available) return;
    const { accountId, workspaceId, enrollment } = await seed();
    const currentDigest = "ab".repeat(32);
    await handleHelloPayload(
      db,
      undefined,
      Hello.encode(
        Hello.fromPartial({
          agentId: enrollment.id,
          workspaceId,
          agentVersion: "0.1.15",
          binarySha256: currentDigest,
          updateChannel: "stable",
        }),
      ).finish(),
      `agent.${workspaceId}.${enrollment.id}.connection.${CONNECTION_INSTANCE_ID}.hello`,
    );
    const live = await getEnrollment(db, workspaceId, enrollment.id);
    const operationId = crypto.randomUUID();
    await beginEnrollmentAgentUpdate(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      connectionInstanceId: CONNECTION_INSTANCE_ID,
      connectionGeneration: live!.connectionGeneration,
      operationId,
      targetVersion: "0.1.16",
    });
    const requests: ControlRequest[] = [];
    const app = appFor(
      busWithAgent({
        workspaceId,
        agentId: enrollment.id,
        online: true,
        onRequest: (request) => requests.push(request),
      }),
      {
        settings: {
          ...settings,
          agentStableVersion: "0.1.16",
          publicBaseUrl: "https://dev.opengeni.example",
        },
      },
    );
    const response = await app.request(
      `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/update`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await bearer(accountId, workspaceId, ["enrollments:manage"])}`,
        },
      },
    );
    expect(response.status).toBe(202);
    expect((await response.json()) as { operationId: string }).toMatchObject({ operationId });
    expect(requests.find((request) => request.op?.$case === "agentUpdateApply")?.requestId).toBe(
      operationId,
    );
    expect((await getEnrollment(db, workspaceId, enrollment.id))?.agentUpdate).toMatchObject({
      operationId,
      status: "accepted",
    });
  }, 90_000);
});

describe("M10 flag gate + authz", () => {
  test("flag OFF → /machines + /metrics/series 404; cross-workspace bearer → 403", async () => {
    if (!available) return;
    const { accountId, workspaceId, enrollment, bus } = await seed();

    // Flag OFF → 404 (invisible).
    const offApp = appFor(bus, { settings: { ...settings, sandboxSelfhostedEnabled: false } });
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;
    expect(
      (
        await offApp.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: auth },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await offApp.request(
          `/v1/workspaces/${workspaceId}/machines/${enrollment.id}/metrics/series`,
          { headers: { authorization: auth } },
        )
      ).status,
    ).toBe(404);

    // Cross-workspace: a bearer for a DIFFERENT workspace cannot read this one (403).
    const other = await freshWorkspace();
    const onApp = appFor(bus);
    const crossAuth = `Bearer ${await bearer(other.accountId, other.workspaceId, ["enrollments:read"])}`;
    expect(
      (
        await onApp.request(`/v1/workspaces/${workspaceId}/machines`, {
          headers: { authorization: crossAuth },
        })
      ).status,
    ).toBe(403);

    // No bearer at all → 401.
    expect((await onApp.request(`/v1/workspaces/${workspaceId}/machines`)).status).toBe(401);
  }, 90_000);
});

describe("machine.link.* fan-out — link-plane session events on going-offline / reconnect", () => {
  // Read the machine-link events a session accumulated (ordered), each with the
  // turn they were stamped on.
  async function machineLinkEvents(
    sessionId: string,
  ): Promise<Array<{ type: string; turn_id: string | null }>> {
    return await admin<{ type: string; turn_id: string | null }[]>`
      select type, turn_id from session_events
      where session_id = ${sessionId}
        and (type like 'machine.link.%' or type = 'machine.runner.restarted')
      order by sequence`;
  }

  // Point a seeded session at its machine's sandbox with a running turn, so the
  // fan-out query counts it as "a session with an active op on the machine".
  async function makeActiveOp(
    accountId: string,
    workspaceId: string,
    sessionId: string,
    sandboxId: string,
    turnId: string,
  ): Promise<void> {
    await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId,
      targetSandboxId: sandboxId,
      expectedEpoch: 0,
    });
    await admin`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`;
  }

  function helloBytes(agentId: string, workspaceId: string): Uint8Array {
    return Hello.encode(
      Hello.fromPartial({ agentId, workspaceId, capabilities: { desktop: true } }),
    ).finish();
  }

  test("a self-update GoingOffline fans out link.lost + runner.restarted to the active-op session, on its running turn", async () => {
    if (!available) return;
    const { accountId, workspaceId, session, enrollment, sandbox, bus } = await seed();
    const turnId = "dddddddd-0000-4000-8000-000000000001";
    await makeActiveOp(accountId, workspaceId, session.id, sandbox.id, turnId);
    appFor(bus); // starts the metrics-ingestion consumer

    await emitGoingOffline(
      bus,
      workspaceId,
      enrollment.id,
      GoingOfflineReason.GOING_OFFLINE_REASON_UPDATE,
    );

    const events = await machineLinkEvents(session.id);
    expect(events.map((e) => e.type)).toEqual(["machine.link.lost", "machine.runner.restarted"]);
    // Both are stamped on the session's OWN running turn.
    expect(events.every((e) => e.turn_id === turnId)).toBe(true);
  }, 90_000);

  test("a plain (non-update) GoingOffline fans out link.lost ONLY (no runner.restarted)", async () => {
    if (!available) return;
    const { accountId, workspaceId, session, enrollment, sandbox, bus } = await seed();
    const turnId = "dddddddd-0000-4000-8000-000000000002";
    await makeActiveOp(accountId, workspaceId, session.id, sandbox.id, turnId);
    appFor(bus);

    await emitGoingOffline(
      bus,
      workspaceId,
      enrollment.id,
      GoingOfflineReason.GOING_OFFLINE_REASON_HOST_SHUTDOWN,
    );

    expect((await machineLinkEvents(session.id)).map((e) => e.type)).toEqual(["machine.link.lost"]);
  }, 90_000);

  test("a reconnect Hello after a lost fans out link.restored; a second Hello (marker already cleared) emits nothing more", async () => {
    if (!available) return;
    const { accountId, workspaceId, session, enrollment, sandbox, bus } = await seed();
    const turnId = "dddddddd-0000-4000-8000-000000000003";
    await makeActiveOp(accountId, workspaceId, session.id, sandbox.id, turnId);
    appFor(bus);

    // Lose the link first (sets the marker + emits link.lost).
    await emitGoingOffline(
      bus,
      workspaceId,
      enrollment.id,
      GoingOfflineReason.GOING_OFFLINE_REASON_USER_STOP,
    );

    // Reconnect: the Hello clears the marker → emits link.restored on the turn.
    await claimConnection(workspaceId, enrollment.id);
    await handleHelloPayload(
      db,
      undefined,
      helloBytes(enrollment.id, workspaceId),
      `agent.${workspaceId}.${enrollment.id}.connection.${CONNECTION_INSTANCE_ID}.hello`,
      bus,
    );
    const afterFirst = await machineLinkEvents(session.id);
    const restored = afterFirst.filter((e) => e.type === "machine.link.restored");
    expect(restored).toHaveLength(1);
    expect(restored[0]!.turn_id).toBe(turnId);

    // A second Hello finds no marker to clear → no further restored (a restored only
    // ever pairs a prior lost).
    await handleHelloPayload(
      db,
      undefined,
      helloBytes(enrollment.id, workspaceId),
      `agent.${workspaceId}.${enrollment.id}.connection.${CONNECTION_INSTANCE_ID}.hello`,
      bus,
    );
    const afterSecond = await machineLinkEvents(session.id);
    expect(afterSecond.filter((e) => e.type === "machine.link.restored")).toHaveLength(1);
  }, 90_000);

  test("no session with an active op on the machine ⇒ a GoingOffline emits NO session events (idle blip stays silent)", async () => {
    if (!available) return;
    // seed() creates a session but does NOT point it at the machine / give it a
    // running turn, so the fan-out query matches nothing.
    const { workspaceId, session, enrollment, bus } = await seed();
    appFor(bus);

    await emitGoingOffline(
      bus,
      workspaceId,
      enrollment.id,
      GoingOfflineReason.GOING_OFFLINE_REASON_UPDATE,
    );

    expect(await machineLinkEvents(session.id)).toEqual([]);
    // And nothing leaked onto any other session in the workspace either.
    const [{ count }] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_events
      where workspace_id = ${workspaceId}
        and (type like 'machine.link.%' or type = 'machine.runner.restarted')`;
    expect(count).toBe(0);
  }, 90_000);

  test("a per-session emission failure is ISOLATED: the first session's append rejecting still delivers to the rest + logs the failure", async () => {
    if (!available) return;
    const { accountId, workspaceId, enrollment, sandbox, bus } = await seed();

    // Two sessions with an active op on the machine. sessionA is created first, so
    // the fan-out's stable order (oldest first) processes it FIRST.
    const mk = async (msg: string) =>
      await createSession(db, {
        accountId,
        workspaceId,
        initialMessage: msg,
        resources: [],
        metadata: {},
        model: "gpt-test",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "modal",
      });
    const sessionA = await mk("a");
    const sessionB = await mk("b");
    await makeActiveOp(
      accountId,
      workspaceId,
      sessionA.id,
      sandbox.id,
      "eeeeeeee-0000-4000-8000-000000000001",
    );
    await makeActiveOp(
      accountId,
      workspaceId,
      sessionB.id,
      sandbox.id,
      "eeeeeeee-0000-4000-8000-000000000002",
    );

    // Rig sessionA's NEXT append to REJECT: pre-occupy its next sequence slot so the
    // unique (workspace, session, sequence) index throws on sessionA's fan-out
    // append — a faithful stand-in for the session-specific / racing-writer failure
    // the isolation must survive. sessionB is untouched.
    const [{ last_sequence: lastSeqA }] = await admin<{ last_sequence: number }[]>`
      select last_sequence from sessions where id = ${sessionA.id}`;
    await admin`
      insert into session_events (account_id, workspace_id, session_id, sequence, type)
      values (${accountId}, ${workspaceId}, ${sessionA.id}, ${lastSeqA + 1}, 'user.message')`;

    // Capture warns; call the handler directly so the per-session log is observable.
    const warns: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const observability = {
      incrementCounter: () => {},
      warn: (message: string, meta?: Record<string, unknown>) => warns.push({ message, meta }),
    } as unknown as Parameters<typeof handleAgentEventPayload>[1];
    const payload = AgentEvent.encode({
      agentId: enrollment.id,
      event: {
        $case: "goingOffline",
        goingOffline: { reason: GoingOfflineReason.GOING_OFFLINE_REASON_UPDATE },
      },
    }).finish();
    await handleAgentEventPayload(
      db,
      observability,
      payload,
      `agent.${workspaceId}.${enrollment.id}.connection.${CONNECTION_INSTANCE_ID}.events`,
      bus,
    );

    // sessionA's append rejected → it got NO machine-link events...
    expect(await machineLinkEvents(sessionA.id)).toEqual([]);
    // ...but sessionB, processed AFTER the failure, still received its full set.
    expect((await machineLinkEvents(sessionB.id)).map((e) => e.type)).toEqual([
      "machine.link.lost",
      "machine.runner.restarted",
    ]);
    // ...and the failure is visible in the logs, naming the failed sessionId.
    expect(warns.some((w) => w.meta?.sessionId === sessionA.id)).toBe(true);
  }, 90_000);
});
