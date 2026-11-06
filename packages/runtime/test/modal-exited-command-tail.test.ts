import { expect, test } from "bun:test";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import type { ChannelASession } from "../src/sandbox/channel-a";
import { withProviderCommandHandle } from "../src/sandbox/provider-command-session";
import {
  MODAL_EXITED_TAIL_READ_MS,
  ModalCommandControl,
} from "../src/sandbox/providers/modal-command-control";
import { installModalCommandSession } from "../src/sandbox/providers/modal-command-session";
import type { ModalCommandRouterWire } from "../src/sandbox/providers/modal-command-router-wire";
import { MODAL_ROUTER_READ_PAGE_BYTES } from "../src/sandbox/providers/modal-command-router-wire";

type CacheEntry = { router: ModalCommandRouterWire; users: number; refreshAt: number };

const command = {
  kind: "modal-router-v1",
  sandboxId: "sandbox-shared",
  taskId: "task-shared",
  execId: "0b8c3c6e-5d0e-4c55-9d1e-6d3f1d0b2a11",
  streams: {
    stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
  },
} satisfies ModalRouterProviderCommand;

/** A router that answers the exit poll at once but delivers a stream's
 * remaining bytes and EOF only after `eofLatencyMs`, as a busy or distant
 * command router does. Like the real wire, a read whose deadline passes first
 * returns what it has without EOF. */
function slowEofRouter(
  eofLatencyMs: number,
  options: { stdout?: Buffer; exit?: number | null; neverEof?: boolean } = {},
) {
  const output = { stdout: options.stdout ?? Buffer.from("done\n"), stderr: Buffer.alloc(0) };
  const reads: number[] = [];
  let polls = 0;
  const router = {
    close: () => {},
    read: async (
      _identity: unknown,
      stream: "stdout" | "stderr",
      offset: number,
      waitMs: number,
      signal: AbortSignal,
    ) => {
      reads.push(waitMs);
      const deliverAt = Math.max(0, eofLatencyMs);
      if (options.neverEof || waitMs < deliverAt) {
        await Bun.sleep(waitMs);
        signal.throwIfAborted();
        return { bytes: Buffer.alloc(0), eof: false };
      }
      await Bun.sleep(deliverAt);
      signal.throwIfAborted();
      // Like the wire, one read returns at most one page and then reports no EOF.
      const rest = output[stream].subarray(offset);
      const bytes = rest.subarray(0, MODAL_ROUTER_READ_PAGE_BYTES);
      return { bytes, eof: bytes.length === rest.length };
    },
    poll: async () => {
      polls++;
      return options.exit === undefined ? 0 : options.exit;
    },
  } as unknown as ModalCommandRouterWire;
  return { router, reads, polls: () => polls };
}

function control(router: ModalCommandRouterWire, sandboxId = "sandbox-shared") {
  const value = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: {
        taskGetCommandRouterAccess: async () => {
          throw new Error("unexpected router lookup");
        },
      },
    } as never,
    sandboxId,
    "/workspace",
  );
  (value as unknown as { routers: Map<string, Promise<CacheEntry>> }).routers.set(
    "task-shared",
    Promise.resolve({ router, users: 0, refreshAt: Date.now() + 60_000 }),
  );
  return value;
}

test("an exited command's tail is read past a short slice, so its exit is observed", async () => {
  const { router } = slowEofRouter(400);
  const value = control(router);
  try {
    const page = await value.read(command, 250);
    expect(page.exitCode).toBe(0);
    expect(page.chunks.map((chunk) => chunk.text).join("")).toBe("done\n");
  } finally {
    await value.close();
  }
});

test("a running command still returns at its slice without waiting for a tail", async () => {
  const { router } = slowEofRouter(400, { exit: null });
  const value = control(router);
  try {
    const started = performance.now();
    const page = await value.read(command, 250);
    expect(page.exitCode).toBeNull();
    expect(page.chunks).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  } finally {
    await value.close();
  }
});

test("an exited tail larger than one page is cut at the page cap and continued", async () => {
  const big = Buffer.alloc(MODAL_ROUTER_READ_PAGE_BYTES + 10, "a");
  const { router } = slowEofRouter(400, { stdout: big });
  const value = control(router);
  try {
    const first = await value.read(command, 250);
    expect(first.exitCode).toBeNull();
    const firstText = first.chunks.map((chunk) => chunk.text).join("");
    expect(firstText.length).toBe(MODAL_ROUTER_READ_PAGE_BYTES);
    const second = await value.read(first.command as ModalRouterProviderCommand, 250);
    expect(second.exitCode).toBe(0);
    expect(second.chunks.map((chunk) => chunk.text).join("")).toBe("a".repeat(10));
  } finally {
    await value.close();
  }
}, 15_000);

test("an exited command whose pipe stays open costs the tail wait once per retry interval", async () => {
  const { router } = slowEofRouter(0, { neverEof: true });
  const value = control(router);
  try {
    let started = performance.now();
    const first = await value.read(command, 100);
    expect(first.exitCode).toBeNull();
    expect(performance.now() - started).toBeGreaterThanOrEqual(MODAL_EXITED_TAIL_READ_MS - 50);
    started = performance.now();
    const second = await value.read(command, 100);
    expect(second.exitCode).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
    // After the retry interval the tail gets another full read, so a router
    // that was only slow is not left on the short window for good.
    const tails = (value as unknown as { openTails: Map<string, number> }).openTails;
    for (const key of tails.keys()) tails.set(key, performance.now() - 1);
    started = performance.now();
    await value.read(command, 100);
    expect(performance.now() - started).toBeGreaterThanOrEqual(MODAL_EXITED_TAIL_READ_MS - 50);
  } finally {
    await value.close();
  }
}, 15_000);

let execs = 0;

/** One agent session whose exec_command is served by its own control over a
 * router shared with every other session on the same box. */
function boxSession(router: ModalCommandRouterWire, sandboxId: string) {
  const value = control(router, sandboxId);
  const session: ChannelASession = {};
  installModalCommandSession(session, {
    start: async () => ({
      ...structuredClone(command),
      sandboxId,
      execId: `0b8c3c6e-5d0e-4c55-9d1e-${String(++execs).padStart(12, "0")}`,
    }),
    read: (input, waitMs, signal) => value.read(input, waitMs, signal),
    readProbe: async () => {
      throw new Error("unexpected probe");
    },
    write: async () => {
      throw new Error("unexpected input write");
    },
  });
  return { session, control: value };
}

// Each read opens fresh router streams and polls the exit directly; no
// per-command watcher is armed at start, so a resumed control or a second
// session on the same box has nothing to re-establish. With a prompt router,
// resume plus attach alone keeps the fast path. With a router slower than the
// turn's slice, the exit is still returned at once.
for (const [latency, label] of [
  [0, "a prompt router"],
  [400, "a router slower than the read slice"],
] as const)
  test(`after resume and a shared-box child attach with ${label}, a fast command returns at exit with its receipt`, async () => {
    const { router } = slowEofRouter(latency);
    const parent = boxSession(router, "sandbox-shared");
    const child = boxSession(router, "sandbox-shared");
    try {
      for (const [handle, { session }] of [
        [11, parent],
        [12, child],
        [13, parent],
      ] as const) {
        const started = performance.now();
        const result = await withProviderCommandHandle(handle, () =>
          session.execCommand!({ cmd: "find . -maxdepth 1", yieldTimeMs: 250 }),
        );
        expect(result).toContain("Provider output receipt:");
        expect(result).toContain("Process exited with code 0");
        expect(result).toContain("done");
        expect(performance.now() - started).toBeLessThan(2_000);
      }
    } finally {
      await parent.control.close();
      await child.control.close();
    }
  });
