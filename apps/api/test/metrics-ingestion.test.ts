import { describe, expect, test } from "bun:test";
import {
  AGENT_EVENTS_SUBJECT,
  handleAgentEventPayload,
  parseAgentEventSubject,
  wireSampleToDbSample,
} from "../src/sandbox/metrics-ingestion";
import { AgentEvent, GoingOfflineReason, type MetricsSample } from "@opengeni/agent-proto";

// M10 — the PURE metrics-ingestion helpers (subject parse + wire→DB sample
// projection). No DB / broker — the round-trip ingestion through createApp + a
// real postgres is covered by machines-routes.test.ts.

describe("parseAgentEventSubject", () => {
  test("extracts workspaceId + agentId from agent.<ws>.<id>.events", () => {
    expect(parseAgentEventSubject("agent.ws-123.ag-456.events")).toEqual({
      workspaceId: "ws-123",
      agentId: "ag-456",
    });
  });

  test("the wildcard subscription subject is agent.*.*.events", () => {
    expect(AGENT_EVENTS_SUBJECT).toBe("agent.*.*.events");
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
      "agent.11111111-1111-1111-1111-111111111111.agent-abc.events",
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
