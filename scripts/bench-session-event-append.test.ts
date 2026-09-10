import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { distribution, scalingReceipts } from "./bench-session-event-append";

describe("session event append benchmark receipts", () => {
  test("stamps the current runtime receipt before the raw FORCE-RLS tenancy probe", () => {
    const source = readFileSync(
      new URL("./bench-session-event-append.ts", import.meta.url),
      "utf8",
    );
    const receipt = source.indexOf("opengeni.session_variable_set_attachments_v1");
    const sessionProbe = source.indexOf("select count(*)::integer as count from sessions");
    expect(receipt).toBeGreaterThan(-1);
    expect(sessionProbe).toBeGreaterThan(receipt);
  });

  test("fails closed unless the receipt captures durable PostgreSQL posture", () => {
    const source = readFileSync(
      new URL("./bench-session-event-append.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("current_setting('server_version')");
    expect(source).toContain("extname = 'vector'");
    expect(source).toContain('server.fsync !== "on"');
    expect(source).toContain('server.synchronousCommit !== "on"');
    expect(source).toContain('server.fullPageWrites !== "on"');
    expect(source).toContain('!forceRls.get("session_event_cursors")');
    expect(source).toContain('sessionEventCursorsForceRls: forceRls.get("session_event_cursors")');
    expect(source).toContain("left join session_event_cursors cursor");
    expect(source).toContain("projectionAheadSessions");
  });

  test("reports nearest-rank latency percentiles", () => {
    expect(distribution([5, 1, 4, 2, 3])).toEqual({
      samples: 5,
      min: 1,
      p50: 3,
      p95: 5,
      p99: 5,
      max: 5,
    });
  });

  test("computes independent-session scaling against the matching serial scenario", () => {
    const latencyMs = { samples: 10, min: 1, p50: 1, p95: 1, p99: 1, max: 1 };
    expect(
      scalingReceipts(
        [
          {
            name: "same_workspace_raw_10_c1",
            topology: "same_workspace",
            eventClass: "raw",
            batchSize: 10,
            concurrency: 1,
            latencyMs,
            throughputPerSecond: 100,
          },
          {
            name: "same_workspace_raw_10_c8",
            topology: "same_workspace",
            eventClass: "raw",
            batchSize: 10,
            concurrency: 8,
            latencyMs,
            throughputPerSecond: 720,
          },
        ],
        8,
      ),
    ).toEqual([
      {
        topology: "same_workspace",
        eventClass: "raw",
        batchSize: 10,
        concurrency: 8,
        efficiency: 0.9,
      },
    ]);
  });
});
