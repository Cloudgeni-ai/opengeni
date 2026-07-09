import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  testSettings,
  MemoryEventBus,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { AgentEvent, ControlRequest, ControlResponse } from "@opengeni/agent-proto";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  createDb,
  createEnrollment,
  createSandbox,
  createSession,
  listSandboxes,
  revokeEnrollment,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { subjectFor } from "@opengeni/runtime";
import { createApp } from "../src/app";
import type { AppDependencies, SessionWorkflowClient } from "@opengeni/core";
import { startMetricsIngestion } from "../src/sandbox/metrics-ingestion";

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
}): MemoryEventBus {
  const bus = new MemoryEventBus();
  if (!opts.online) {
    return bus;
  }
  bus.subscribeRequests(subjectFor(opts.workspaceId, opts.agentId), (payload) => {
    const req = ControlRequest.decode(payload);
    const op = req.op;
    const res: ControlResponse =
      op?.$case === "ping"
        ? {
            requestId: req.requestId,
            result: { $case: "ping", ping: { nonce: op.ping.nonce, agentMonotonicMs: "0" } },
          }
        : {
            requestId: req.requestId,
            error: { code: 0, message: "unsupported", retryable: false, detail: {} },
          };
    return ControlResponse.encode(res).finish();
  });
  return bus;
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
  await bus.emitAgentEvent(`agent.${workspaceId}.${agentId}.events`, event);
}

function appFor(bus: MemoryEventBus, overrides: Partial<AppDependencies> = {}) {
  const noop = async () => {};
  const workflowClient = {
    signalUserMessage: noop,
    wakeSessionWorkflow: noop,
    signalApprovalDecision: noop,
    signalInterrupt: noop,
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
  return { accountId: a!.id, workspaceId: w!.id };
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
});

type SeedOpts = { online?: boolean; hasDisplay?: boolean; allowScreenControl?: boolean };
async function seed(opts: SeedOpts = {}) {
  const { accountId, workspaceId } = await freshWorkspace();
  const session = await createSession(db, {
    accountId,
    workspaceId,
    initialMessage: "hi",
    resources: [],
    metadata: {},
    model: "gpt-test",
    sandboxBackend: "modal",
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
  const bus = busWithAgent({ workspaceId, agentId: enrollment.id, online: opts.online ?? true });
  return { accountId, workspaceId, session, enrollment, sandbox, bus };
}

describe("M10 GET /machines — dashboard list + states + metrics", () => {
  test("an online machine returns the contract shape with latest metrics; ?sessionId adds the synthetic group + active pointer", async () => {
    if (!available) return;
    const { accountId, workspaceId, session, enrollment, sandbox, bus } = await seed();
    const app = appFor(bus);
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;

    // Drive a heartbeat → the ingestion consumer upserts the latest metrics row.
    await emitHeartbeat(bus, workspaceId, enrollment.id, 42.5);

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

  test("state matrix: displayed-but-unconsented is ONLINE (view/control decoupled); offline when no responder", async () => {
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
    // offline: online=false → no responder → the probe misses; lastSeenAt is recent
    // BUT we clear it so it is hard-offline.
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

  test("probes enrolled machines in parallel while preserving sandbox order", async () => {
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

    const expectedOrder = (await listSandboxes(db, workspaceId)).map((sandbox) => sandbox.id);
    const bus = new SlowProbeBus(150);
    const app = appFor(bus);
    const auth = `Bearer ${await bearer(accountId, workspaceId, ["enrollments:read"])}`;

    const startedAt = performance.now();
    const res = await app.request(`/v1/workspaces/${workspaceId}/machines`, {
      headers: { authorization: auth },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(res.status).toBe(200);
    const body = (await res.json()) as { machines: Array<{ sandboxId: string }> };
    expect(body.machines.map((machine) => machine.sandboxId)).toEqual(expectedOrder);
    expect(bus.startedSubjects.length).toBe(3);
    expect(bus.completed).toBe(3);
    expect(bus.maxInFlight).toBe(3);
    expect(elapsedMs).toBeLessThan(450);
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
