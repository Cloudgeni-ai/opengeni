import { describe, expect, test } from "bun:test";

import { buildSessionRealtimeDelegationTerminalProjection } from "../src/session-realtime-terminal";

const accountId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const turnId = "00000000-0000-4000-8000-000000000004";
const eventId = "00000000-0000-4000-8000-000000000005";

function input(output: string, retainedOutputEvidence?: unknown) {
  return {
    accountId,
    workspaceId,
    sessionId,
    turnId,
    turnStatus: "completed" as const,
    terminalEvent: {
      id: eventId,
      type: "turn.completed" as const,
      payload: { output },
    },
    retainedOutputEvidence,
  };
}

describe("realtime terminal projection", () => {
  test("preserves ordinary terminal output exactly", () => {
    const output = "ordinary source\u0000\ud800|\udc00";
    const projected = buildSessionRealtimeDelegationTerminalProjection(input(output));

    expect(projected.text).toBe(output);
    expect(projected.payload).toEqual({
      status: "completed",
      turnId,
      terminalEventId: eventId,
      terminalEventType: "turn.completed",
      terminal: { output },
    });
  });

  test("references oversized canonical output with validated retained evidence", () => {
    const output = `large\u0000\ud800${"x".repeat(150_000)}`;
    const artifactId = "00000000-0000-4000-8000-000000000006";
    const evidence = {
      available: true as const,
      artifactId,
      kind: "assistant_completion" as const,
      contentType: "text/plain",
      originalBytes: 150_008,
      sha256: "a".repeat(64),
      retainedAt: "2026-08-05T00:00:00.000Z",
      retention: { policy: "workspace_file" as const, expiresAt: null },
      retrieval: {
        method: "GET" as const,
        path: `/v1/workspaces/${workspaceId}/artifacts/${artifactId}/content`,
        acceptRanges: "bytes" as const,
        maxRangeBytes: 1024 * 1024,
      },
    };
    const projected = buildSessionRealtimeDelegationTerminalProjection(input(output, evidence));

    expect(Buffer.byteLength(projected.text, "utf8")).toBeLessThanOrEqual(131_072);
    expect(Buffer.byteLength(JSON.stringify(projected.payload), "utf8")).toBeLessThanOrEqual(
      131_072,
    );
    expect(JSON.stringify(projected)).not.toContain(output);
    expect(projected.payload).toMatchObject({
      status: "completed",
      turnId,
      terminalEventId: eventId,
      terminal: {
        canonicalEvent: { id: eventId, type: "turn.completed" },
        truncation: {
          truncated: true,
          reason: "realtime_ledger_limit",
          fullEvidence: evidence,
        },
      },
    });
  });

  test("fails closed for malformed retained-output evidence without changing canonical truth", () => {
    const output = "x".repeat(150_000);
    const projected = buildSessionRealtimeDelegationTerminalProjection(
      input(output, {
        available: true,
        artifactId: "not-an-artifact",
        kind: "assistant_completion",
      }),
    );

    expect(projected.payload).toMatchObject({
      terminal: {
        canonicalEvent: { id: eventId, type: "turn.completed" },
        truncation: {
          truncated: true,
          fullEvidence: { available: false, reason: "not_retained" },
        },
      },
    });
  });
});
