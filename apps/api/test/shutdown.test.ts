import { describe, expect, test } from "bun:test";
import { installApiShutdownHandlers } from "../src/shutdown";

function fixture() {
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  return {
    process: {
      on: (signal: string, handler: () => void) => {
        handlers.set(signal, handler);
      },
      off: (signal: string, handler: () => void) => {
        if (handlers.get(signal) === handler) handlers.delete(signal);
      },
      exit: (code: number) => {
        exits.push(code);
        resolveExit(code);
      },
    },
    emit: (signal: string) => handlers.get(signal)?.(),
    handlers,
    exits,
    exited,
  };
}

describe("standalone API shutdown", () => {
  test("both signals close once, await cleanup, then exit", async () => {
    const f = fixture();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    installApiShutdownHandlers({
      process: f.process,
      close: async () => {
        calls++;
        await cleanup;
      },
    });
    f.emit("SIGTERM");
    f.emit("SIGINT");
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(f.exits).toEqual([]);
    release();
    expect(await f.exited).toBe(0);
    expect(f.handlers.size).toBe(0);
    expect(f.exits).toEqual([0]);
  });

  test("a cleanup failure is bounded and never exposes the error content", async () => {
    const f = fixture();
    let failures = 0;
    installApiShutdownHandlers({
      process: f.process,
      close: () => {
        throw new Error("private fixture diagnostic");
      },
      onFailure: () => {
        failures++;
        throw new Error("observer failed");
      },
    });
    f.emit("SIGINT");
    expect(await f.exited).toBe(1);
    expect(failures).toBe(1);
    expect(f.handlers.size).toBe(0);
  });

  test("a stalled close cannot keep the process alive indefinitely or exit twice", async () => {
    const f = fixture();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    installApiShutdownHandlers({ process: f.process, timeoutMs: 5, close: () => cleanup });
    f.emit("SIGTERM");
    expect(await f.exited).toBe(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.exits).toEqual([1]);
  });

  test("an embedded owner can dispose handlers without closing its server", () => {
    const f = fixture();
    let calls = 0;
    const dispose = installApiShutdownHandlers({
      process: f.process,
      close: async () => {
        calls++;
      },
    });
    dispose();
    f.emit("SIGINT");
    expect(calls).toBe(0);
    expect(f.handlers.size).toBe(0);
  });
});
