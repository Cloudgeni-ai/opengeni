import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import { readCommandWithWait } from "../src/mcp/command-read";
import { projectCommandOutputPage } from "@opengeni/db/session-background-commands";

const commandId = crypto.randomUUID();
const event = (id = commandId) =>
  ({ type: "session.command.finished", payload: { commandId: id } }) as SessionEvent;

describe("shared command read/wait backend", () => {
  test("retention-gap pages with more output return immediately instead of timing out", async () => {
    const rows = Array.from({ length: 65 }, (_, index) => ({
      sequence: index + 1,
      payload:
        index < 64 ? { commandReadProjectionGap: true } : { chunk: "ready", stream: "stdout" },
      payloadCodecVersion: null,
    }));
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 1,
      read: async () => ({ terminal: false, ...projectCommandOutputPage({ commandId, rows }) }),
      subscribe: async () => () => {},
    });
    expect(result.chunks).toEqual([]);
    expect(result.hasMore).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.waitedMs).toBeLessThan(500);
    const next = projectCommandOutputPage({
      commandId,
      rows: rows.slice(64),
      cursor: result.nextCursor,
    });
    expect(next.chunks[0]?.chunk).toBe("ready");
  });
  test("immediate running reads do not subscribe or wait", async () => {
    const result = await readCommandWithWait({
      commandId,
      read: async () => ({ terminal: false, chunks: [] }),
      subscribe: async () => {
        throw new Error("must not subscribe");
      },
    });
    expect(result).toMatchObject({ terminal: false, timedOut: false, liveFanout: true });
  });
  test("terminal retained result returns immediately and releases subscription", async () => {
    let released = false;
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 50,
      read: async () => ({ terminal: true, chunks: [{ chunk: "done" }] }),
      subscribe: async () => () => {
        released = true;
      },
    });
    expect(result.terminal).toBe(true);
    expect(released).toBe(true);
  });
  test("only exact command notifications wake and durable reread owns result", async () => {
    let onEvents!: (events: SessionEvent[]) => void;
    let reads = 0;
    let finish = false;
    const pending = readCommandWithWait({
      commandId,
      waitSeconds: 1,
      read: async () => {
        reads++;
        return { terminal: finish, chunks: [] };
      },
      subscribe: async (listener) => {
        onEvents = listener;
        return () => {};
      },
    });
    await Bun.sleep(10);
    onEvents([event(crypto.randomUUID())]);
    await Bun.sleep(10);
    expect(reads).toBe(1);
    finish = true;
    onEvents([event()]);
    expect((await pending).terminal).toBe(true);
    expect(reads).toBe(2);
  });
  test("deadline rechecks durable result when live fanout is unavailable", async () => {
    let reads = 0;
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 1,
      read: async () => ({ terminal: ++reads === 2, chunks: [] }),
      subscribe: async () => {
        throw new Error("offline");
      },
    });
    expect(result).toMatchObject({ terminal: true, liveFanout: false, timedOut: false });
  });
  test("missed output fanout is recovered by a durable reread before the deadline", async () => {
    let reads = 0;
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 10,
      read: async () => ({ terminal: false, chunks: ++reads > 1 ? [{ chunk: "new output" }] : [] }),
      subscribe: async () => () => {},
    });
    expect(result.chunks).toEqual([{ chunk: "new output" }]);
    expect(result.timedOut).toBe(false);
    expect(reads).toBe(2);
  });
  test("abort releases the wait; bounds reject before reading", async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 50,
      signal: abort.signal,
      read: async () => ({ terminal: false, chunks: [] }),
      subscribe: async () => () => {},
    });
    expect(result.aborted).toBe(true);
    await expect(
      readCommandWithWait({
        commandId,
        waitSeconds: 51,
        read: async () => {
          throw new Error("must not read");
        },
        subscribe: async () => () => {},
      }),
    ).rejects.toThrow("waitSeconds");
  });
});

describe("command_wait poll floor (settings.experimentPollFloor)", () => {
  // Test-scale floor; production passes POLL_FLOOR_MS and the cut-polling
  // quiet thresholds for Connected Machine commands (server.ts).
  const floor = {
    floorMs: 2_000,
    outputQuietMs: 600,
    promptQuietMs: 300,
    looksLikeInputPrompt: (output: string) => /\[y\/N\]\s*$/.test(output),
  };

  /** A command whose output (from the caller's cursor) and exit follow a script. */
  function scripted(output: Array<{ atMs: number; chunk: string }>, exitAtMs?: number) {
    const startedAt = Date.now();
    let onEvents: ((events: SessionEvent[]) => void) | undefined;
    let reads = 0;
    return {
      get reads() {
        return reads;
      },
      emit: (events: SessionEvent[]) => onEvents?.(events),
      read: async () => {
        reads++;
        const elapsed = Date.now() - startedAt;
        return {
          terminal: exitAtMs !== undefined && elapsed >= exitAtMs,
          chunks: output.filter((entry) => entry.atMs <= elapsed).map(({ chunk }) => ({ chunk })),
        };
      },
      subscribe: async (listener: (events: SessionEvent[]) => void) => {
        onEvents = listener;
        return () => {};
      },
    };
  }

  const delta = () =>
    ({ type: "sandbox.command.output.delta", payload: { commandId } }) as SessionEvent;

  test("without the floor the first chunk returns the wait (unchanged)", async () => {
    const command = scripted([{ atMs: 0, chunk: "compiling 1/40\n" }]);
    const result = await readCommandWithWait({ commandId, waitSeconds: 5, ...command });
    expect(result.chunks).toHaveLength(1);
    expect(result.waitedMs).toBeLessThan(200);
  });

  test("streaming output is held until the floor and returned in one result", async () => {
    const output = Array.from({ length: 20 }, (_, index) => ({
      atMs: index * 200,
      chunk: `step ${index}\n`,
    }));
    const command = scripted(output);
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 1,
      pollFloor: floor,
      ...command,
    });
    expect(result.terminal).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(1_950);
    expect(result.waitedMs).toBeLessThan(3_000);
    expect(result.chunks.length).toBeGreaterThan(5);
  });

  test("a silent command waits the floor even when the model asked for less", async () => {
    const command = scripted([]);
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 1,
      pollFloor: floor,
      ...command,
    });
    expect(result.timedOut).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(1_950);
  });

  test("returns as soon as the command exits", async () => {
    const command = scripted([{ atMs: 0, chunk: "building\n" }], 400);
    const pending = readCommandWithWait({
      commandId,
      waitSeconds: 10,
      pollFloor: floor,
      ...command,
    });
    setTimeout(
      () =>
        command.emit([
          { type: "session.command.finished", payload: { commandId } } as SessionEvent,
        ]),
      420,
    );
    const result = await pending;
    expect(result.terminal).toBe(true);
    expect(result.waitedMs).toBeLessThan(700);
  });

  test("returns once output goes quiet (dev server ready)", async () => {
    const command = scripted([
      { atMs: 0, chunk: "starting\n" },
      { atMs: 200, chunk: "ready on :3000\n" },
    ]);
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 10,
      pollFloor: floor,
      ...command,
    });
    expect(result.terminal).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(750);
    // Below the 2-second floor, with headroom for timer drift.
    expect(result.waitedMs).toBeLessThan(1_900);
    expect(result.chunks.map((chunk) => chunk.chunk).join("")).toBe("starting\nready on :3000\n");
  });

  test("returns quickly on an input prompt", async () => {
    const command = scripted([{ atMs: 0, chunk: "Overwrite? [y/N] " }]);
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 10,
      pollFloor: floor,
      ...command,
    });
    expect(result.waitedMs).toBeGreaterThanOrEqual(250);
    expect(result.waitedMs).toBeLessThan(1_000);
  });

  test("output deltas do not turn the floor into a read loop", async () => {
    const command = scripted([{ atMs: 0, chunk: "x" }]);
    const pending = readCommandWithWait({
      commandId,
      waitSeconds: 1,
      pollFloor: { ...floor, outputQuietMs: 60_000, promptQuietMs: 60_000 },
      ...command,
    });
    const flood = setInterval(() => command.emit([delta()]), 5);
    const result = await pending;
    clearInterval(flood);
    expect(result.waitedMs).toBeGreaterThanOrEqual(1_950);
    // One read per ~500 ms re-read, not one per delta.
    expect(command.reads).toBeLessThan(10);
  });

  test("abort ends a floored wait promptly", async () => {
    const abort = new AbortController();
    const command = scripted([{ atMs: 0, chunk: "x" }]);
    setTimeout(() => abort.abort(), 200);
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 1,
      pollFloor: floor,
      signal: abort.signal,
      ...command,
    });
    expect(result.waitedMs).toBeLessThan(500);
  });

  test("an immediate read (waitSeconds 0) is never floored", async () => {
    const command = scripted([]);
    const result = await readCommandWithWait({ commandId, pollFloor: floor, ...command });
    expect(result.waitedMs).toBeLessThan(100);
  });

  test("hasMore pages still return immediately under the floor", async () => {
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 10,
      pollFloor: floor,
      read: async () => ({ terminal: false, chunks: [{ chunk: "a" }], hasMore: true }),
      subscribe: async () => () => {},
    });
    expect(result.hasMore).toBe(true);
    expect(result.waitedMs).toBeLessThan(100);
  });
});
