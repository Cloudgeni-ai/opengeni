import { describe, expect, test } from "bun:test";
import {
  createAgentEventIngestionScheduler,
  handleAgentEventPayload,
  parseAgentEventSubject,
  wireAttachedBrowserInventoryToContract,
  wireSampleToDbSample,
} from "../src/sandbox/metrics-ingestion";
import {
  AgentEvent,
  Arch,
  GoingOfflineReason,
  Os,
  type AttachedBrowserInventorySnapshot,
  type MetricsSample,
} from "@opengeni/agent-proto";

// M10 — the PURE metrics-ingestion helpers (subject parse + wire→DB sample
// projection). No DB / broker — the round-trip ingestion through createApp + a
// real postgres is covered by machines-routes.test.ts.

describe("parseAgentEventSubject", () => {
  test("extracts workspace, enrollment, and process from a fenced event", () => {
    expect(
      parseAgentEventSubject(
        "agent.ws-123.ag-456.connection.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.events",
      ),
    ).toEqual({
      workspaceId: "ws-123",
      agentId: "ag-456",
      connectionInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
  });

  test("rejects a malformed / non-events subject", () => {
    expect(parseAgentEventSubject("agent.ws.ag.rpc")).toBeNull();
    expect(parseAgentEventSubject("agent.ws.events")).toBeNull();
    expect(parseAgentEventSubject("not.an.agent.subject")).toBeNull();
  });
});

describe("handleAgentEventPayload — GoingOffline machine-plane recording", () => {
  function counterCapture() {
    const counters: Array<{ name: string; labels?: Record<string, string> }> = [];
    return { counters, observability: { incrementCounter: (c: never) => counters.push(c) } };
  }

  test("a clean GoingOffline increments the counter by typed reason (counter fires independent of the DB)", async () => {
    const { counters, observability } = counterCapture();
    const payload = AgentEvent.encode({
      event: {
        $case: "goingOffline",
        goingOffline: { reason: GoingOfflineReason.GOING_OFFLINE_REASON_UPDATE },
      },
    }).finish();
    // The machine-plane counter fires FIRST + unconditionally; the enrollment-marker
    // write that follows is best-effort + fail-soft. A bare stub `db` makes that
    // write throw, which the branch swallows — so the counter still lands. (The real
    // DB round-trip through setEnrollmentWentOffline is covered in machines-routes.)
    await handleAgentEventPayload(
      {} as never,
      observability as never,
      payload,
      "agent.11111111-1111-1111-1111-111111111111.agent-abc.connection.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.events",
    );
    expect(counters).toHaveLength(1);
    expect(counters[0]!.name).toBe("opengeni_machine_going_offline_total");
    expect(counters[0]!.labels?.reason).toBe("GOING_OFFLINE_REASON_UPDATE");
  });

  test("a malformed subject is ignored (no counter, no throw)", async () => {
    const { counters, observability } = counterCapture();
    const payload = AgentEvent.encode({
      event: {
        $case: "goingOffline",
        goingOffline: { reason: GoingOfflineReason.GOING_OFFLINE_REASON_USER_STOP },
      },
    }).finish();
    await handleAgentEventPayload(
      {} as never,
      observability as never,
      payload,
      "not.an.events.subject",
    );
    expect(counters).toHaveLength(0);
  });
});

describe("Connected Machine event ingestion scheduling", () => {
  const subjectA =
    "agent.11111111-1111-4111-8111-111111111111.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.connection.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.events";
  const subjectB =
    "agent.22222222-2222-4222-8222-222222222222.cccccccc-cccc-4ccc-8ccc-cccccccccccc.connection.dddddddd-dddd-4ddd-8ddd-dddddddddddd.events";

  function heartbeat(seq: number): Uint8Array {
    return AgentEvent.encode({
      event: {
        $case: "heartbeat",
        heartbeat: {
          seq: String(seq),
          uptimeMs: String(seq * 5_000),
          activeSessions: 0,
          draining: false,
        },
      },
    }).finish();
  }

  function goingOffline(): Uint8Array {
    return AgentEvent.encode({
      event: {
        $case: "goingOffline",
        goingOffline: { reason: GoingOfflineReason.GOING_OFFLINE_REASON_HOST_SHUTDOWN },
      },
    }).finish();
  }

  test("drains separate runners concurrently and bounds a busy runner to the latest consecutive heartbeat", async () => {
    const handledA: string[] = [];
    const handledB: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let runnerBHandled!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const runnerBHandledPromise = new Promise<void>((resolve) => {
      runnerBHandled = resolve;
    });
    let coalesced = 0;

    const scheduler = createAgentEventIngestionScheduler(
      async (payload, subject) => {
        const event = AgentEvent.decode(payload).event;
        const label =
          event?.$case === "heartbeat" ? `heartbeat:${event.heartbeat.seq}` : "goingOffline";
        if (subject === subjectA) {
          handledA.push(label);
          if (label === "heartbeat:1") {
            firstStarted();
            await firstGate;
          }
        } else {
          handledB.push(label);
          runnerBHandled();
        }
      },
      { onHeartbeatCoalesced: () => (coalesced += 1) },
    );

    scheduler.enqueue(heartbeat(1), subjectA);
    await firstStartedPromise;
    for (let seq = 2; seq <= 100; seq += 1) scheduler.enqueue(heartbeat(seq), subjectA);
    scheduler.enqueue(goingOffline(), subjectA);
    for (let seq = 101; seq <= 200; seq += 1) scheduler.enqueue(heartbeat(seq), subjectA);

    scheduler.enqueue(heartbeat(7), subjectB);
    await runnerBHandledPromise;
    expect(handledB).toEqual(["heartbeat:7"]);

    releaseFirst();
    await scheduler.whenIdle();
    expect(handledA).toEqual(["heartbeat:1", "heartbeat:100", "goingOffline", "heartbeat:200"]);
    expect(coalesced).toBe(197);
  });

  test("a rejected event does not strand later liveness for the same runner", async () => {
    const handled: string[] = [];
    const scheduler = createAgentEventIngestionScheduler(async (payload) => {
      const event = AgentEvent.decode(payload).event;
      if (event?.$case === "heartbeat") handled.push(event.heartbeat.seq);
    });

    scheduler.enqueue(Uint8Array.from([0xff]), subjectA);
    scheduler.enqueue(heartbeat(2), subjectA);
    await scheduler.whenIdle();
    expect(handled).toEqual(["2"]);
  });

  test("bounds cross-runner database concurrency without serializing every runner", async () => {
    let releaseHandlers!: () => void;
    let fourHandlersStarted!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandlers = resolve;
    });
    const fourHandlersStartedPromise = new Promise<void>((resolve) => {
      fourHandlersStarted = resolve;
    });
    let active = 0;
    let peak = 0;
    let handled = 0;

    const scheduler = createAgentEventIngestionScheduler(
      async () => {
        active += 1;
        handled += 1;
        peak = Math.max(peak, active);
        if (handled === 4) fourHandlersStarted();
        await handlerGate;
        active -= 1;
      },
      { maxConcurrentSubjects: 4 },
    );

    for (let index = 0; index < 12; index += 1) {
      scheduler.enqueue(heartbeat(index + 1), `runner-${index}`);
    }

    await fourHandlersStartedPromise;
    expect(peak).toBe(4);
    expect(handled).toBe(4);

    releaseHandlers();
    await scheduler.whenIdle();
    expect(handled).toBe(12);
    expect(peak).toBe(4);
  });
});

describe("wireSampleToDbSample", () => {
  function wire(overrides: Partial<MetricsSample> = {}): MetricsSample {
    return {
      sampledAtMs: String(1_700_000_000_000),
      cpuPercent: 42.5,
      load1: 0.5,
      load5: 0.4,
      load15: 0.3,
      memUsedBytes: "1024",
      memTotalBytes: "4096",
      diskUsedBytes: "2048",
      diskTotalBytes: "8192",
      runQueue: 2,
      gpus: [],
      ...overrides,
    };
  }

  test("projects the proto fields (string uint64 → number) to the DB sample shape", () => {
    const db = wireSampleToDbSample(wire());
    expect(db.cpuPercent).toBe(42.5);
    expect(db.load1).toBe(0.5);
    expect(db.memUsedBytes).toBe(1024);
    expect(db.memTotalBytes).toBe(4096);
    expect(db.diskUsedBytes).toBe(2048);
    expect(db.diskTotalBytes).toBe(8192);
    // runQueue maps to the DB `contention` signal.
    expect(db.contention).toBe(2);
    expect(db.sampledAt.getTime()).toBe(1_700_000_000_000);
  });

  test("no GPUs → gpu fields null (the not-reported contract)", () => {
    const db = wireSampleToDbSample(wire({ gpus: [] }));
    expect(db.gpuUtilPercent).toBeNull();
    expect(db.gpuMemUsedBytes).toBeNull();
    expect(db.gpuMemTotalBytes).toBeNull();
  });

  test("the FIRST GPU is surfaced (the primary accelerator)", () => {
    const db = wireSampleToDbSample(
      wire({
        gpus: [
          { name: "A100", utilPercent: 73, memUsedBytes: "4096", memTotalBytes: "40960" },
          { name: "A100#2", utilPercent: 12, memUsedBytes: "1024", memTotalBytes: "40960" },
        ],
      }),
    );
    expect(db.gpuUtilPercent).toBe(73);
    expect(db.gpuMemUsedBytes).toBe(4096);
    expect(db.gpuMemTotalBytes).toBe(40960);
  });

  test("a missing/zero sampledAtMs falls back to now (never a null-dated row)", () => {
    const before = Date.now();
    const db = wireSampleToDbSample(wire({ sampledAtMs: "0" }));
    expect(db.sampledAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("wireAttachedBrowserInventoryToContract", () => {
  function inventory(
    overrides: Partial<AttachedBrowserInventorySnapshot> = {},
  ): AttachedBrowserInventorySnapshot {
    return {
      bridgeGeneration: "bridge-generation-1",
      revision: "12",
      devices: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Primary Chrome",
          profileLabel: "cloudgeni.ai",
          browserName: "Chrome",
          browserVersion: "151.0.0.0",
          extensionVersion: "1.0.0",
          platform: Os.OS_MACOS,
          arch: Arch.ARCH_AARCH64,
          connectionGeneration: "extension-connection-1",
          inventoryRevision: "9",
          tabCount: 3,
          capabilities: {
            tabInventory: true,
            debuggerAttachment: true,
            semanticObservation: true,
            screenshots: true,
            liveFrames: true,
            humanInput: true,
            diagnostics: true,
            rawCdp: false,
            linkedComputer: true,
          },
        },
      ],
      ...overrides,
    };
  }

  test("projects one complete browser bridge snapshot without conflating its identity", () => {
    expect(wireAttachedBrowserInventoryToContract(inventory())).toEqual({
      bridgeGeneration: "bridge-generation-1",
      revision: 12,
      devices: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Primary Chrome",
          profileLabel: "cloudgeni.ai",
          browserName: "Chrome",
          browserVersion: "151.0.0.0",
          extensionVersion: "1.0.0",
          platform: "macos",
          architecture: "arm64",
          connectionGeneration: "extension-connection-1",
          inventoryRevision: 9,
          tabCount: 3,
          capabilities: expect.objectContaining({ debuggerAttachment: true }),
        },
      ],
    });
  });

  test("rejects an unsafe uint64 before an authoritative snapshot can disconnect peers", () => {
    expect(() =>
      wireAttachedBrowserInventoryToContract(
        inventory({ revision: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n) }),
      ),
    ).toThrow("safe integer range");
  });

  test("rejects unspecified platform and architecture rather than guessing", () => {
    const wire = inventory();
    wire.devices[0]!.platform = Os.OS_UNSPECIFIED;
    expect(() => wireAttachedBrowserInventoryToContract(wire)).toThrow("platform is unspecified");
  });
});
