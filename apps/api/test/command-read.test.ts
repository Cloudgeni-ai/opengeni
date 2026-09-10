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
