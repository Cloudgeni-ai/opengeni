import { expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import type { ModalCommandRouterWire } from "../src/sandbox/providers/modal-command-router-wire";
import { ProviderCommandObservationUnavailableError } from "../src/sandbox/provider-command-session";

type CacheEntry = { router: ModalCommandRouterWire; users: number; refreshAt: number };
type CacheControl = {
  routers: Map<string, Promise<CacheEntry>>;
  withRouter<T>(
    taskId: string,
    signal: AbortSignal | undefined,
    run: (router: ModalCommandRouterWire) => Promise<T>,
  ): Promise<T>;
};

function fixture() {
  let lookups = 0;
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: {
        taskGetCommandRouterAccess: async ({ taskId }: { taskId: string }) => {
          expect(taskId).toBe("task-original");
          lookups++;
          return { url: "https://localhost:1", jwt: "test-authenticated-access" };
        },
      },
    } as never,
    "sandbox-original",
    "/workspace",
  );
  // Exercise the production cache implementation, replacing only its initial
  // entry. Creating the replacement wire performs no command or physical RPC.
  return { control, cache: control as unknown as CacheControl, lookups: () => lookups };
}

function pendingAccessFixture() {
  let resolve!: (access: { url: string; jwt: string }) => void;
  let providerSignal!: AbortSignal;
  let lookups = 0;
  const pending = new Promise<{ url: string; jwt: string }>((fulfill) => {
    resolve = fulfill;
  });
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: {
        taskGetCommandRouterAccess: (_request: unknown, options: { signal: AbortSignal }) => {
          lookups++;
          providerSignal = options.signal;
          // Deliberately ignores cancellation, exercising bounded waiter cleanup.
          return pending;
        },
      },
    } as never,
    "sandbox-original",
    "/workspace",
  );
  return {
    control,
    cache: control as unknown as CacheControl,
    resolve: () => resolve({ url: "https://localhost:1", jwt: "test-authenticated-access" }),
    signal: () => providerSignal,
    lookups: () => lookups,
  };
}

test("the first caller's cancellation does not cancel shared authenticated access", async () => {
  const f = pendingAccessFixture();
  const first = new AbortController();
  const reason = new Error("first owner cancelled");
  let runs = 0;
  const cancelled = f.cache
    .withRouter("task-original", first.signal, async () => runs++)
    .catch((error) => error);
  const sibling = f.cache.withRouter("task-original", undefined, async () => runs++);
  first.abort(reason);
  try {
    expect(await cancelled).toBe(reason);
    expect(f.signal().aborted).toBe(false);
    expect(f.lookups()).toBe(1);
    f.resolve();
    await sibling;
    expect(runs).toBe(1);
  } finally {
    await f.control.close();
  }
});

test("a cancelled shared lookup waiter returns without waiting for its sibling or provider", async () => {
  const f = pendingAccessFixture();
  const owner = new AbortController();
  const sibling = f.cache.withRouter("task-original", undefined, async () => "sibling");
  const reason = new Error("second owner cancelled");
  const cancelled = f.cache
    .withRouter("task-original", owner.signal, async () => "cancelled")
    .catch((error) => error);
  owner.abort(reason);
  try {
    expect(await Promise.race([cancelled, Bun.sleep(200).then(() => "timeout")])).toBe(reason);
    expect(f.signal().aborted).toBe(false);
    f.resolve();
    expect(await sibling).toBe("sibling");
    expect(f.lookups()).toBe(1);
  } finally {
    await f.control.close();
  }
});

test("the last cancelled waiter and close drain an uncooperative access lookup", async () => {
  const f = pendingAccessFixture();
  const owner = new AbortController();
  const reason = new Error("only owner cancelled");
  const cancelled = f.cache
    .withRouter("task-original", owner.signal, async () => "unexpected")
    .catch((error) => error);
  owner.abort(reason);
  expect(await cancelled).toBe(reason);
  expect(f.signal().aborted).toBe(true);
  expect(f.cache.routers.has("task-original")).toBe(false);
  expect(
    await Promise.race([
      f.control.close().then(() => "closed"),
      Bun.sleep(200).then(() => "timeout"),
    ]),
  ).toBe("closed");
  f.resolve();
});

test("concurrent expiry continuations preserve one fresh authenticated router", async () => {
  const f = fixture();
  let closes = 0;
  const old = { close: () => closes++ } as unknown as ModalCommandRouterWire;
  f.cache.routers.set("task-original", Promise.resolve({ router: old, users: 0, refreshAt: 0 }));
  const observed = new Set<ModalCommandRouterWire>();
  try {
    const run = async (router: ModalCommandRouterWire) => {
      observed.add(router);
      return router;
    };
    const [first, second] = await Promise.all([
      f.cache.withRouter("task-original", undefined, run),
      f.cache.withRouter("task-original", undefined, run),
    ]);
    expect(f.lookups()).toBe(1);
    expect(closes).toBe(1);
    expect(first).toBe(second);
    expect((await f.cache.routers.get("task-original"))?.router).toBe(first);
  } finally {
    // Also close an orphan if the regression fails against the old source.
    for (const router of observed) router.close();
    await f.control.close();
  }
});

test("same-invocation read retry never retires a concurrent active router", async () => {
  const f = fixture();
  let closes = 0;
  let failures = 1;
  const observations: Array<{ execId: string; stream: string; offset: number }> = [];
  const original = {
    kind: "modal-router-v1",
    sandboxId: "sandbox-original",
    taskId: "task-original",
    execId: "79c723cd-ce29-4614-9424-d3171d24d55f",
    streams: {
      stdout: { byteOffset: 7, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 11, utf8Remainder: "", eof: false, exitCode: null },
    },
  } satisfies ModalRouterProviderCommand;
  const router = {
    close: () => closes++,
    read: async ({ execId }: { execId: string }, stream: string, offset: number) => {
      observations.push({ execId, stream, offset });
      if (stream === "stdout" && failures-- > 0)
        throw Object.assign(new Error("read unavailable"), { code: 14 });
      return { bytes: Buffer.alloc(0), eof: true };
    },
    poll: async () => 0,
  } as unknown as ModalCommandRouterWire;
  const entry = { router, users: 0, refreshAt: Date.now() + 60_000 };
  f.cache.routers.set("task-original", Promise.resolve(entry));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const sibling = f.cache.withRouter("task-original", undefined, async (current) => {
    expect(current).toBe(router);
    entered();
    await held;
  });
  try {
    await active;
    entry.refreshAt = 0;
    const page = await f.control.read(original, 1_000);
    expect(page.exitCode).toBe(0);
    expect(page.command).toMatchObject({
      sandboxId: original.sandboxId,
      taskId: original.taskId,
      execId: original.execId,
    });
    expect(observations).toHaveLength(4);
    expect(observations.every(({ execId }) => execId === original.execId)).toBe(true);
    expect(
      observations.every(({ stream, offset }) => offset === (stream === "stdout" ? 7 : 11)),
    ).toBe(true);
    expect(entry.users).toBe(1);
    expect(closes).toBe(0);
    expect(f.lookups()).toBe(0);
  } finally {
    release();
    await sibling;
    await f.control.close();
  }
});

test("a quiet stream's read deadline returns a partial page before outer containment", async () => {
  const f = fixture();
  const original = {
    kind: "modal-router-v1",
    sandboxId: "sandbox-original",
    taskId: "task-original",
    execId: "79c723cd-ce29-4614-9424-d3171d24d55f",
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  } satisfies ModalRouterProviderCommand;
  const router = {
    close: () => {},
    read: async (
      _command: unknown,
      stream: string,
      _offset: number,
      waitMs: number,
      signal: AbortSignal,
    ) => {
      if (stream === "stdout") return { bytes: Buffer.from("partial"), eof: false };
      await Bun.sleep(waitMs + 10);
      signal.throwIfAborted();
      return { bytes: Buffer.alloc(0), eof: false };
    },
    poll: async () => null,
  } as unknown as ModalCommandRouterWire;
  f.cache.routers.set(
    "task-original",
    Promise.resolve({ router, users: 0, refreshAt: Date.now() + 60_000 }),
  );
  try {
    const page = await f.control.read(original, 20);
    expect(page.chunks.map((chunk) => chunk.text)).toEqual(["partial"]);
    expect(page.command.streams.stdout).toMatchObject({ byteOffset: 7, eof: false });
    expect(page.exitCode).toBeNull();
  } finally {
    await f.control.close();
  }
});

test("settlement allowance never admits another read after the original retry budget", async () => {
  const f = fixture();
  let stdoutReads = 0;
  const router = {
    close: () => {},
    read: async (_identity: unknown, stream: string) => {
      if (stream === "stdout") {
        stdoutReads++;
        await Bun.sleep(40);
        throw Object.assign(new Error("read unavailable"), { code: 14 });
      }
      return { bytes: Buffer.alloc(0), eof: false };
    },
    poll: async () => null,
  } as unknown as ModalCommandRouterWire;
  f.cache.routers.set(
    "task-original",
    Promise.resolve({ router, users: 0, refreshAt: Date.now() + 60_000 }),
  );
  const command: ModalRouterProviderCommand = {
    kind: "modal-router-v1",
    sandboxId: "sandbox-original",
    taskId: "task-original",
    execId: "79c723cd-ce29-4614-9424-d3171d24d55f",
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
  try {
    await expect(f.control.read(command, 20)).rejects.toThrow();
    expect(stdoutReads).toBe(1);
  } finally {
    await f.control.close();
  }
});

test("late authenticated access cannot start observations after the original read budget", async () => {
  const f = fixture();
  let reads = 0;
  const router = {
    close: () => {},
    read: async () => {
      reads++;
      return { bytes: Buffer.alloc(0), eof: true };
    },
    poll: async () => 0,
  } as unknown as ModalCommandRouterWire;
  const pending = Bun.sleep(80).then(() => ({ router, users: 0, refreshAt: Date.now() + 60_000 }));
  f.cache.routers.set("task-original", pending);
  const command: ModalRouterProviderCommand = {
    kind: "modal-router-v1",
    sandboxId: "sandbox-original",
    taskId: "task-original",
    execId: "79c723cd-ce29-4614-9424-d3171d24d55f",
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
  try {
    await expect(f.control.read(command, 20)).rejects.toBeInstanceOf(
      ProviderCommandObservationUnavailableError,
    );
    await pending;
    expect(reads).toBe(0);
  } finally {
    await f.control.close();
  }
});

test("captured complete streams retain their terminal observation without a provider handle", async () => {
  const f = fixture();
  const command: ModalRouterProviderCommand = {
    kind: "modal-router-v1",
    sandboxId: "sandbox-original",
    taskId: "task-original",
    execId: "79c723cd-ce29-4614-9424-d3171d24d55f",
    streams: {
      stdout: { byteOffset: 7, utf8Remainder: "", eof: true, exitCode: 7 },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: true, exitCode: 7 },
    },
  };
  try {
    const page = await f.control.read(command, 0);
    expect(page.exitCode).toBe(7);
    expect(page.command).toEqual(command);
    expect(page.expected).toEqual(command);
    expect(page.chunks).toEqual([]);
    expect(f.lookups()).toBe(0);
    const cancelled = new AbortController();
    cancelled.abort(new Error("owner cancelled"));
    await expect(f.control.read(command, 0, cancelled.signal)).rejects.toThrow("owner cancelled");
  } finally {
    await f.control.close();
  }
});

test("incomplete or contradictory captured streams still require provider observation", async () => {
  const f = fixture();
  let polls = 0;
  const router = {
    close: () => {},
    read: async () => ({ bytes: Buffer.alloc(0), eof: true }),
    poll: async () => {
      polls++;
      throw new Error("provider handle unavailable");
    },
  } as unknown as ModalCommandRouterWire;
  f.cache.routers.set(
    "task-original",
    Promise.resolve({ router, users: 0, refreshAt: Date.now() + 60_000 }),
  );
  const command: ModalRouterProviderCommand = {
    kind: "modal-router-v1",
    sandboxId: "sandbox-original",
    taskId: "task-original",
    execId: "79c723cd-ce29-4614-9424-d3171d24d55f",
    streams: {
      stdout: { byteOffset: 7, utf8Remainder: "", eof: true, exitCode: 0 },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: true, exitCode: 1 },
    },
  };
  try {
    await expect(f.control.read(command, 0)).rejects.toThrow("provider handle unavailable");
    command.streams.stderr = { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null };
    await expect(f.control.read(command, 0)).rejects.toThrow("provider handle unavailable");
    expect(polls).toBe(2);
  } finally {
    await f.control.close();
  }
});
