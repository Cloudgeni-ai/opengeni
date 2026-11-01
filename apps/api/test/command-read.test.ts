import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import { readCommandWithWait, readCommandsWithWait } from "../src/mcp/command-read";

const commandId = crypto.randomUUID();
const event = (id = commandId, type = "session.command.finished") =>
  ({ type, payload: { commandId: id } }) as SessionEvent;

describe("shared command read/wait backend", () => {
  test("new output alone does not end a wait; the read after it returns everything", async () => {
    let onEvents!: (events: SessionEvent[]) => void;
    let reads = 0;
    const pending = readCommandWithWait({
      commandId,
      waitSeconds: 1,
      isTerminal: async () => false,
      read: async () => {
        reads++;
        return { terminal: false, chunks: [{ chunk: "line 1\nline 2\n" }], hasMore: false };
      },
      subscribe: async (listener) => {
        onEvents = listener;
        return () => {};
      },
    });
    await Bun.sleep(20);
    onEvents([event(commandId, "sandbox.command.output.delta")]);
    const result = await pending;
    expect(reads).toBe(1);
    expect(result.chunks).toEqual([{ chunk: "line 1\nline 2\n" }]);
    expect(result.timedOut).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(1_000);
  });
  test("immediate running reads do not subscribe or wait", async () => {
    const result = await readCommandWithWait({
      commandId,
      read: async () => ({ terminal: false, chunks: [] }),
      isTerminal: async () => {
        throw new Error("must not wait");
      },
      subscribe: async () => {
        throw new Error("must not subscribe");
      },
    });
    expect(result).toMatchObject({ terminal: false, timedOut: false, liveFanout: true });
  });
  test("terminal retained result returns immediately and releases subscription", async () => {
    let released = false;
    const started = Date.now();
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 50,
      isTerminal: async () => true,
      read: async () => ({ terminal: true, chunks: [{ chunk: "done" }] }),
      subscribe: async () => () => {
        released = true;
      },
    });
    expect(result.terminal).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(released).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
  test("only exact finish notifications wake; output is read once at the end", async () => {
    let onEvents!: (events: SessionEvent[]) => void;
    let checks = 0;
    let reads = 0;
    let finish = false;
    const pending = readCommandWithWait({
      commandId,
      waitSeconds: 5,
      isTerminal: async () => {
        checks++;
        return finish;
      },
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
    expect(checks).toBe(1);
    expect(reads).toBe(0);
    finish = true;
    onEvents([event()]);
    const result = await pending;
    expect(result.terminal).toBe(true);
    expect(result.waitedMs).toBeLessThan(1_000);
    expect(checks).toBe(2);
    expect(reads).toBe(1);
  });
  test("a lost finish notification is recovered by the durable recheck", async () => {
    let checks = 0;
    let finished = false;
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 10,
      isTerminal: async () => (finished = ++checks >= 2),
      read: async () => ({ terminal: finished, chunks: [{ chunk: "done" }] }),
      subscribe: async () => {
        throw new Error("offline");
      },
    });
    expect(result).toMatchObject({ terminal: true, liveFanout: false, timedOut: false });
    expect(result.waitedMs).toBeLessThan(3_000);
  });
  test("a pending Steer ends the wait early with the current read", async () => {
    let onEvents!: (events: SessionEvent[]) => void;
    let steer = false;
    const pending = readCommandWithWait({
      commandId,
      waitSeconds: 20,
      isTerminal: async () => false,
      read: async () => ({ terminal: false, chunks: [{ chunk: "partial" }] }),
      subscribe: async (listener) => {
        onEvents = listener;
        return () => {};
      },
      yieldTo: async () => steer,
    });
    await Bun.sleep(20);
    steer = true;
    onEvents([{ type: "session.control.steer_requested", payload: {} } as SessionEvent]);
    const result = await pending;
    expect(result).toMatchObject({ yielded: true, timedOut: false, terminal: false });
    expect(result.waitedMs).toBeLessThan(1_000);
  });
  test("abort releases the wait; bounds reject before reading", async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await readCommandWithWait({
      commandId,
      waitSeconds: 50,
      signal: abort.signal,
      isTerminal: async () => false,
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

describe("waiting on several commands", () => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();

  test('waitFor "all" returns once every command settles and splits the budget', async () => {
    let onEvents!: (events: SessionEvent[]) => void;
    const finished = new Set<string>();
    const budgets: Array<number | undefined> = [];
    const pending = readCommandsWithWait({
      commandIds: [first, second, first],
      waitSeconds: 10,
      maxOutputBytes: 1000,
      isTerminal: async (id) => finished.has(id),
      read: async (id, budget) => {
        budgets.push(budget);
        return { commandId: id, terminal: finished.has(id), chunks: [{ chunk: id }] };
      },
      subscribe: async (listener) => {
        onEvents = listener;
        return () => {};
      },
    });
    await Bun.sleep(20);
    finished.add(first);
    onEvents([event(first)]);
    await Bun.sleep(20);
    finished.add(second);
    onEvents([event(second)]);
    const result = await pending;
    expect(result.commands.map((command) => command.commandId)).toEqual([first, second]);
    expect(result.commands.every((command) => command.terminal)).toBe(true);
    expect(result).toMatchObject({ waitFor: "all", timedOut: false });
    expect(result.waitedMs).toBeLessThan(1_000);
    expect(budgets).toEqual([500, 500]);
  });

  test('waitFor "any" returns when the first command settles', async () => {
    let onEvents!: (events: SessionEvent[]) => void;
    const finished = new Set<string>();
    const pending = readCommandsWithWait({
      commandIds: [first, second],
      waitFor: "any",
      waitSeconds: 10,
      isTerminal: async (id) => finished.has(id),
      read: async (id) => ({ commandId: id, terminal: finished.has(id), chunks: [] }),
      subscribe: async (listener) => {
        onEvents = listener;
        return () => {};
      },
    });
    await Bun.sleep(20);
    finished.add(second);
    onEvents([event(second)]);
    const result = await pending;
    expect(result.commands.map((command) => command.terminal)).toEqual([false, true]);
    expect(result).toMatchObject({ waitFor: "any", timedOut: false });
    expect(result.waitedMs).toBeLessThan(1_000);
  });

  test("the deadline reports a timeout with each command's current read", async () => {
    const result = await readCommandsWithWait({
      commandIds: [first, second],
      waitSeconds: 1,
      isTerminal: async (id) => id === first,
      read: async (id) => ({ commandId: id, terminal: id === first, chunks: [] }),
      subscribe: async () => () => {},
    });
    expect(result.timedOut).toBe(true);
    expect(result.commands.map((command) => command.terminal)).toEqual([true, false]);
    await expect(
      readCommandsWithWait({
        commandIds: Array.from({ length: 9 }, () => crypto.randomUUID()),
        isTerminal: async () => true,
        read: async () => ({ terminal: true, chunks: [] }),
        subscribe: async () => () => {},
      }),
    ).rejects.toThrow("at most 8");
  });
});
