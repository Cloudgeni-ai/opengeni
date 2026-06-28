// M7 — the RoutingSandboxSession proxy (the hot-swap dispatch core).
//
// The load-bearing SDK finding (dossier §10.3): the SDK binds to ONE session
// object and calls its methods per tool call WITHOUT re-resolving. So the proxy
// must be ONE stable object that re-reads the active pointer per op and
// dispatches to the currently-active backend. These tests drive that contract
// with in-memory fake backends + a mutable pointer, plus the real selfhosted
// MockAgentResponder for the heterogeneous Modal<->selfhosted path.
//
// Proves:
//   (1) active-epoch fence: a swap mid-turn (bump active_epoch + repoint) makes
//       the NEXT op route to the new backend (per-call re-read + per-epoch cache).
//   (2) stale-epoch in-flight op: a backend that fences a stale epoch → the proxy
//       re-resolves and RETRIES against the new active sandbox (no lost op).
//   (3) heterogeneous swap (>=2 flips): Modal->selfhosted->modal->selfhosted, ops
//       land on the new active box each time.
//   (4) single-active invariant: exactly one backend is ever resolved per op;
//       never two active concurrently.

import { describe, expect, test } from "bun:test";
import {
  RoutingSandboxSession,
  makeActiveBackendResolver,
  MockAgentResponder,
  type ActivePointer,
  type RoutableBackendSession,
  type ResolvedActiveBackend,
  type RoutableSandbox,
} from "../src/sandbox";

const WS = "11111111-1111-1111-1111-111111111111";
const RELAY = { host: "relay.test", port: 443, tls: true } as const;

/** A trivial in-memory backend whose exec echoes its `tag` so a test can assert
 *  which backend an op landed on. Optionally fences a configured epoch. */
class FakeBackend implements RoutableBackendSession {
  readonly tag: string;
  readonly calls: string[] = [];
  // When set, exec throws a fence error UNTIL the pointer's epoch moves past it.
  fenceUntilEpoch: number | null = null;
  private epochProvider: () => number;
  readonly state: { instanceId: string };

  constructor(tag: string, epochProvider: () => number = () => 0) {
    this.tag = tag;
    this.epochProvider = epochProvider;
    this.state = { instanceId: `box-${tag}` };
  }

  async exec(args: unknown): Promise<{ stdout: string; exitCode: number }> {
    if (this.fenceUntilEpoch !== null && this.epochProvider() <= this.fenceUntilEpoch) {
      const err = new Error("sandbox lease superseded; op fenced by a stale epoch") as Error & { fenced: boolean };
      err.fenced = true;
      throw err;
    }
    this.calls.push(String((args as { cmd?: string }).cmd ?? ""));
    return { stdout: this.tag, exitCode: 0 };
  }

  async readFile(): Promise<Uint8Array> {
    return new TextEncoder().encode(this.tag);
  }
}

/** A mutable active pointer + a swap helper (mirrors setActiveSandbox's
 *  epoch-bump). */
function mutablePointer(initial: ActivePointer = { activeSandboxId: null, activeEpoch: 0 }) {
  let pointer = { ...initial };
  return {
    read: async (): Promise<ActivePointer> => ({ ...pointer }),
    swap: (targetSandboxId: string | null): ActivePointer => {
      pointer = { activeSandboxId: targetSandboxId, activeEpoch: pointer.activeEpoch + 1 };
      return { ...pointer };
    },
    current: (): ActivePointer => ({ ...pointer }),
  };
}

describe("RoutingSandboxSession — per-call re-read + per-epoch dispatch", () => {
  test("(1) active-epoch fence: a swap mid-turn routes the NEXT op to the new backend", async () => {
    const modal = new FakeBackend("modal");
    const selfhosted = new FakeBackend("selfhosted");
    const ptr = mutablePointer();
    let resolves = 0;

    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer): Promise<ResolvedActiveBackend> => {
        resolves += 1;
        return pointer.activeSandboxId === null
          ? { session: modal, sandboxId: null, kind: "modal" }
          : { session: selfhosted, sandboxId: pointer.activeSandboxId, kind: "selfhosted" };
      },
    });

    // Op 1 lands on the default (modal) backend.
    const r1 = (await proxy.exec({ cmd: "a" })) as { stdout: string };
    expect(r1.stdout).toBe("modal");

    // A second op at the SAME epoch reuses the cached backend (no re-resolve).
    await proxy.exec({ cmd: "b" });
    expect(resolves).toBe(1);

    // SWAP mid-turn: bump active_epoch + repoint to the selfhosted sandbox.
    ptr.swap("sbx-self");

    // The NEXT op re-reads the pointer, sees the new epoch, re-resolves, and lands
    // on the selfhosted backend.
    const r2 = (await proxy.exec({ cmd: "c" })) as { stdout: string };
    expect(r2.stdout).toBe("selfhosted");
    expect(resolves).toBe(2);

    // The ops landed on the right boxes: modal saw a+b, selfhosted saw c.
    expect(modal.calls).toEqual(["a", "b"]);
    expect(selfhosted.calls).toEqual(["c"]);
  });

  test("(2) stale-epoch in-flight op: the backend fences a stale epoch -> the proxy retries against the new active sandbox", async () => {
    // The default (modal) box fences any op while the pointer is still at epoch 0
    // (simulating an in-flight op the active_epoch bumped under). After a swap to
    // selfhosted (epoch 1), the proxy must re-resolve and land the op on selfhosted.
    const ptr = mutablePointer();
    const modal = new FakeBackend("modal", () => ptr.current().activeEpoch);
    const selfhosted = new FakeBackend("selfhosted", () => ptr.current().activeEpoch);
    modal.fenceUntilEpoch = 0; // modal rejects while epoch <= 0

    let resolveCount = 0;
    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer): Promise<ResolvedActiveBackend> => {
        resolveCount += 1;
        // On the retry the test bumps the pointer (a concurrent swap) so the
        // re-resolve produces the new active backend.
        if (pointer.activeSandboxId === null) {
          return { session: modal, sandboxId: null, kind: "modal" };
        }
        return { session: selfhosted, sandboxId: pointer.activeSandboxId, kind: "selfhosted" };
      },
      onTransition: (e) => {
        // When the first attempt fences, simulate the concurrent swap that
        // re-points the session to selfhosted (epoch 1) BEFORE the retry resolves.
        if (e.type === "fenced-retry" && ptr.current().activeEpoch === 0) {
          ptr.swap("sbx-self");
        }
      },
    });

    const r = (await proxy.exec({ cmd: "in-flight" })) as { stdout: string };
    // The op was NOT lost: it retried and landed on the NEW active (selfhosted).
    expect(r.stdout).toBe("selfhosted");
    expect(selfhosted.calls).toEqual(["in-flight"]);
    // modal never recorded the call (it only ever fenced).
    expect(modal.calls).toEqual([]);
    // Re-resolved at least twice (initial + post-fence).
    expect(resolveCount).toBeGreaterThanOrEqual(2);
  });

  test("(3) heterogeneous swap (>=2 flips): ops land on the new active box each flip", async () => {
    const modal = new FakeBackend("modal");
    const selfA = new FakeBackend("self-A");
    const selfB = new FakeBackend("self-B");
    const ptr = mutablePointer();

    const byId: Record<string, FakeBackend> = { "sbx-A": selfA, "sbx-B": selfB };
    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer): Promise<ResolvedActiveBackend> => {
        if (pointer.activeSandboxId === null) {
          return { session: modal, sandboxId: null, kind: "modal" };
        }
        return { session: byId[pointer.activeSandboxId]!, sandboxId: pointer.activeSandboxId, kind: "selfhosted" };
      },
    });

    // Flip 0: default modal.
    expect(((await proxy.exec({ cmd: "0" })) as { stdout: string }).stdout).toBe("modal");
    // Flip 1: -> self-A.
    ptr.swap("sbx-A");
    expect(((await proxy.exec({ cmd: "1" })) as { stdout: string }).stdout).toBe("self-A");
    // Flip 2: -> self-B.
    ptr.swap("sbx-B");
    expect(((await proxy.exec({ cmd: "2" })) as { stdout: string }).stdout).toBe("self-B");
    // Flip 3: back to modal (null).
    ptr.swap(null);
    expect(((await proxy.exec({ cmd: "3" })) as { stdout: string }).stdout).toBe("modal");
    // Flip 4: -> self-A again.
    ptr.swap("sbx-A");
    expect(((await proxy.exec({ cmd: "4" })) as { stdout: string }).stdout).toBe("self-A");

    expect(modal.calls).toEqual(["0", "3"]);
    expect(selfA.calls).toEqual(["1", "4"]);
    expect(selfB.calls).toEqual(["2"]);
  });

  test("(4) single-active invariant: exactly one backend resolves per op, never two", async () => {
    const modal = new FakeBackend("modal");
    const selfhosted = new FakeBackend("selfhosted");
    const ptr = mutablePointer();
    let concurrentResolves = 0;
    let maxConcurrent = 0;

    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer): Promise<ResolvedActiveBackend> => {
        concurrentResolves += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentResolves);
        await Promise.resolve();
        concurrentResolves -= 1;
        return pointer.activeSandboxId === null
          ? { session: modal, sandboxId: null, kind: "modal" }
          : { session: selfhosted, sandboxId: pointer.activeSandboxId, kind: "selfhosted" };
      },
    });

    await proxy.exec({ cmd: "x" });
    ptr.swap("sbx-self");
    await proxy.exec({ cmd: "y" });
    // Only ONE backend was ever resolved at a time (single active, not parallel).
    expect(maxConcurrent).toBe(1);
    // After the swap, the modal box is NOT touched again (single-active, the old
    // box is not concurrently driven).
    expect(modal.calls).toEqual(["x"]);
    expect(selfhosted.calls).toEqual(["y"]);
  });
});

describe("makeActiveBackendResolver — heterogeneous default/modal/selfhosted dispatch", () => {
  const sandboxes: Record<string, RoutableSandbox> = {
    "sbx-self": { id: "sbx-self", kind: "selfhosted", name: "my-laptop", enrollmentId: "enroll-1" },
    "sbx-modal": { id: "sbx-modal", kind: "modal", name: "cloud-box", enrollmentId: null },
  };

  test("null pointer -> the default group backend (no re-establish)", async () => {
    const defaultBackend = new FakeBackend("group-modal");
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend,
      defaultKind: "modal",
      getSandbox: async (id) => sandboxes[id] ?? null,
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    const r = await resolve({ activeSandboxId: null, activeEpoch: 0 });
    expect(r.sandboxId).toBeNull();
    expect(r.kind).toBe("modal");
    expect(r.session).toBe(defaultBackend);
  });

  test("selfhosted target -> a SelfhostedSession bound to the enrollment agentId, fenced under active_epoch", async () => {
    const mock = new MockAgentResponder({ hostname: "the-laptop" });
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async (id) => sandboxes[id] ?? null,
      controlRpcFactory: () => mock,
      relay: RELAY,
    });
    const r = await resolve({ activeSandboxId: "sbx-self", activeEpoch: 7 });
    expect(r.kind).toBe("selfhosted");
    expect(r.sandboxId).toBe("sbx-self");
    // The session reaches the enrollment's agent subject.
    const exec = (await (r.session as { exec: (a: unknown) => Promise<{ stdout: string }> }).exec({ cmd: "echo $HOSTNAME" }));
    expect(exec.stdout.trim()).toBe("the-laptop");
    // The op carried the swap's active_epoch as the fence.
    expect(mock.requests[0]?.req.epoch).toBe(7);
    // Addressed to agent.<ws>.<enrollmentId>.rpc (the enrollment IS the agent id).
    expect(mock.requests[0]?.subject).toBe(`agent.${WS}.enroll-1.rpc`);
  });

  test("the resolver threads the run environment into the selfhosted target's manifest (env-parity → no manifest-env delta throw)", async () => {
    // Regression for the pin-to-vm env-delta bug: a selfhosted swap target resolved
    // WITHOUT the run environment gets an empty manifest.environment, and the SDK's
    // per-turn provided-session manifest apply throws "Live sandbox sessions cannot
    // change manifest environment variables." The resolver must thread its
    // `environment` into the SelfhostedSession's manifest so it equals the turn's.
    const env = { GIT_AUTHOR_NAME: "OpenGeni Bot", HOME: "/workspace", DEPLOY_TARGET: "vm2" };
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async (id) => sandboxes[id] ?? null,
      controlRpcFactory: () => new MockAgentResponder({ hostname: "the-laptop" }),
      relay: RELAY,
      environment: env,
    });
    const r = await resolve({ activeSandboxId: "sbx-self", activeEpoch: 7 });
    const manifest = (r.session as { state: { manifest: { resolveEnvironment(): Promise<Record<string, string>>; root: string } } }).state.manifest;
    expect(await manifest.resolveEnvironment()).toEqual(env);
    expect(manifest.root).toBe("/workspace");
  });

  test("modal swap target with no establisher -> unresolvable (caller 409s)", async () => {
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async (id) => sandboxes[id] ?? null,
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    await expect(resolve({ activeSandboxId: "sbx-modal", activeEpoch: 1 })).rejects.toThrow(/cannot be established/);
  });

  test("unknown sandbox id -> unresolvable", async () => {
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async () => null,
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    await expect(resolve({ activeSandboxId: "ghost", activeEpoch: 1 })).rejects.toThrow(/not found/);
  });

  test("end-to-end: proxy + real resolver, swap Modal->selfhosted lands the op on the laptop", async () => {
    const groupModal = new FakeBackend("group-modal");
    const laptop = new MockAgentResponder({ hostname: "laptop-99" });
    const ptr = mutablePointer();
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: groupModal,
      defaultKind: "modal",
      getSandbox: async (id) => sandboxes[id] ?? null,
      controlRpcFactory: () => laptop,
      relay: RELAY,
    });
    const proxy = new RoutingSandboxSession({ readPointer: ptr.read, resolveActiveBackend: resolve });

    // Before swap: the op runs on the group Modal box.
    expect(((await proxy.exec({ cmd: "uname" })) as { stdout: string }).stdout).toBe("group-modal");
    // Swap to the laptop.
    ptr.swap("sbx-self");
    // After swap: the exec reaches the laptop agent (echoes its hostname).
    const r = (await proxy.exec({ cmd: "echo $HOSTNAME" })) as { stdout: string };
    expect(r.stdout.trim()).toBe("laptop-99");
    expect(groupModal.calls).toEqual(["uname"]);
  });
});
