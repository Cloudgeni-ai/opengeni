import { describe, expect, test } from "bun:test";
import { CommandReadResult } from "@opengeni/contracts";
import {
  parseCommandOutputCursor,
  projectCommandOutputPage,
  projectCommandOutputTail,
} from "../src/session-background-commands";
import { toPostgresLosslessJson } from "../src/lossless-json";

const commandId = "a4b6175d-cfc8-4e99-bbef-2ed8f684f3a1";
const row = (sequence: number, chunk: string, stream = "stdout") => ({
  sequence,
  payload: { chunk, stream, commandId },
  payloadCodecVersion: null,
});

describe("command output paging", () => {
  test("public result parsing preserves merged output fidelity", () => {
    const page = projectCommandOutputPage({
      commandId,
      rows: [
        {
          ...row(1, "combined"),
          payload: { chunk: "combined", stream: "stdout", streamFidelity: "merged" },
        },
      ],
    });
    const parsed = CommandReadResult.parse({
      ...page,
      commandId,
      state: "running",
      exitCode: null,
      terminal: false,
      completionObservedAt: null,
      waitedMs: 0,
      timedOut: false,
      aborted: false,
      liveFanout: false,
    });
    expect(parsed.chunks[0]?.streamFidelity).toBe("merged");
  });
  test("byte budgets preserve Unicode and stdout/stderr order across an oversized chunk", () => {
    const rows = [row(7, "😀abé"), row(10, "error", "stderr")];
    const first = projectCommandOutputPage({ commandId, rows, maxOutputBytes: 5 });
    expect(first.chunks).toEqual([
      { sequence: 7, stream: "stdout", streamFidelity: "unknown", chunk: "😀a" },
    ]);
    expect(first.hasMore).toBe(true);
    const second = projectCommandOutputPage({
      commandId,
      rows,
      cursor: first.nextCursor,
      maxOutputBytes: 4,
    });
    expect(second.chunks).toEqual([
      { sequence: 7, stream: "stdout", streamFidelity: "unknown", chunk: "bé" },
      { sequence: 10, stream: "stderr", streamFidelity: "unknown", chunk: "e" },
    ]);
    const third = projectCommandOutputPage({
      commandId,
      rows: rows.slice(1),
      cursor: second.nextCursor,
      maxOutputBytes: 4,
    });
    expect(third.chunks[0]?.chunk).toBe("rror");
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBe(`${commandId}:11:0`);
  });
  test("page row lookahead never consumes the 65th row", () => {
    const rows = Array.from({ length: 65 }, (_, i) => row(i + 1, "x"));
    const page = projectCommandOutputPage({ commandId, rows });
    expect(page.chunks).toHaveLength(64);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(`${commandId}:65:0`);
  });
  test("missing partial output, unavailable chunks and truncation are explicit", () => {
    const page = projectCommandOutputPage({
      commandId,
      cursor: `${commandId}:3:4`,
      rows: [
        { sequence: 8, payload: { truncation: { truncated: true } }, payloadCodecVersion: null },
      ],
    });
    expect(page.retention.gaps).toContain("cursor_output_no_longer_retained");
    expect(page.retention.gaps).toContain("retained_event_has_no_output_chunk");
    expect(page.retention.gaps).toContain("output_truncated_at_retention_boundary");
    expect(page.retention.completeness).toBe("unknown");
    expect(page.hasMore).toBe(false);
  });
  test("lossless encoded output is decoded only with its version", () => {
    const page = projectCommandOutputPage({
      commandId,
      rows: [
        { sequence: 1, payload: toPostgresLosslessJson({ chunk: "a\0b" }), payloadCodecVersion: 1 },
      ],
    });
    expect(page.chunks[0]?.chunk).toBe("a\0b");
  });
  test("rejects cross-command cursors, malformed cursors and invalid budgets", () => {
    expect(() =>
      projectCommandOutputPage({
        commandId,
        rows: [row(7, "😀ab")],
        cursor: `${commandId}:7:1`,
      }),
    ).toThrow("Unicode code point");
    for (const cursor of [
      "other:1:0",
      `${commandId}:-1:0`,
      `${commandId}:1:NaN`,
      `${commandId}:9007199254740992:0`,
    ]) {
      expect(() => parseCommandOutputCursor(cursor, commandId)).toThrow();
    }
    for (const maxOutputBytes of [0, 3, 65_537, NaN, 4.5]) {
      expect(() => projectCommandOutputPage({ commandId, rows: [], maxOutputBytes })).toThrow();
    }
  });
});

describe("command output tail", () => {
  test("returns the newest bytes without splitting a code point", () => {
    const tail = projectCommandOutputTail({
      commandId,
      from: { sequence: 1, offset: 0 },
      maxOutputBytes: 9,
      // Newest first.
      rows: [row(3, "ab🙂"), row(2, "middle"), row(1, "start")],
    });
    // "ab🙂" is 6 bytes; 3 more reach back into row 2 ("dle").
    expect(tail.chunks.map((item) => item.chunk)).toEqual(["dle", "ab🙂"]);
    expect(tail.reachedFrom).toBe(false);
    expect(tail.startCursor).toBe(`${commandId}:2:3`);
    expect(tail.endCursor).toBe(`${commandId}:4:0`);
    const split = projectCommandOutputTail({
      commandId,
      from: { sequence: 1, offset: 0 },
      maxOutputBytes: 3,
      rows: [row(1, "x🙂")],
    });
    expect(split.chunks).toEqual([]);
    expect(split.startCursor).toBe(`${commandId}:1:3`);
  });

  test("stops at the from cursor and reports when it reached it", () => {
    const tail = projectCommandOutputTail({
      commandId,
      from: { sequence: 1, offset: 2 },
      maxOutputBytes: 100,
      rows: [row(2, "end"), row(1, "skipme")],
    });
    expect(tail.chunks.map((item) => item.chunk)).toEqual(["ipme", "end"]);
    expect(tail.reachedFrom).toBe(true);
    // A row beyond the limit proves older output remains, whatever the gaps
    // between sequences; exactly the limit, with no extra row, is complete.
    const rows = Array.from({ length: 65 }, (_, index) => row(200 - index * 2, "a"));
    const limited = projectCommandOutputTail({
      commandId,
      from: { sequence: 1, offset: 0 },
      maxOutputBytes: 1000,
      rows,
    });
    expect(limited.reachedFrom).toBe(false);
    expect(limited.chunks).toHaveLength(64);
    expect(limited.startCursor).toBe(`${commandId}:74:0`);
    const exact = projectCommandOutputTail({
      commandId,
      from: { sequence: 1, offset: 0 },
      maxOutputBytes: 1000,
      rows: rows.slice(0, 64),
    });
    expect(exact.reachedFrom).toBe(true);
    // A smaller row limit applies the same way.
    const few = projectCommandOutputTail({
      commandId,
      from: { sequence: 1, offset: 0 },
      maxOutputBytes: 1000,
      rows: rows.slice(0, 11),
      rowLimit: 10,
    });
    expect(few.chunks).toHaveLength(10);
    expect(few.reachedFrom).toBe(false);
  });
});
