import { expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import type { ModalCommandRouterWire } from "../src/sandbox/providers/modal-command-router-wire";

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
