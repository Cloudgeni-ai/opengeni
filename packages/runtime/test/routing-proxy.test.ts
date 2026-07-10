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
  RoutingUnsupportedError,
  makeActiveBackendResolver,
  ActiveBackendUnresolvableError,
  swapTargetEstablishability,
  MockAgentResponder,
  type ActivePointer,
  type RoutableBackendSession,
  type ResolvedActiveBackend,
  type RoutableSandbox,
} from "../src/sandbox";
// The REAL computer-use discriminator — the proxy's native-surface presence must
// satisfy (and, for Modal, fail) this exact duck-type, not a local reimplementation.
import { isNativeDesktopSession } from "../src/sandbox-computer";

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
      const err = new Error("sandbox lease superseded; op fenced by a stale epoch") as Error & {
        fenced: boolean;
      };
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

/** A backend that ALSO implements the native-desktop control-plane surface
 *  (`desktopInput`/`screenshot`) — the SelfhostedSession shape the computer-use
 *  capability duck-types as native. Records the events it received so a test can
 *  assert the proxy dispatched to it with the right args. */
class NativeFakeBackend extends FakeBackend {
  readonly desktopEvents: unknown[] = [];
  screenshots = 0;
  readonly frame = { png: new Uint8Array([137, 80, 78, 71]), width: 1440, height: 900 };

  async desktopInput(event: unknown): Promise<void> {
    this.desktopEvents.push(event);
  }

  async screenshot(): Promise<{ png: Uint8Array; width: number; height: number }> {
    this.screenshots += 1;
    return this.frame;
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
        return {
          session: byId[pointer.activeSandboxId]!,
          sandboxId: pointer.activeSandboxId,
          kind: "selfhosted",
        };
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

  // REGRESSION (caught live on staging 2026-07-08): the lazy wiring returned the
  // proxy ITSELF as the resolved backend, so every op re-dispatched into resolve()
  // forever — a silent async infinite recursion that HUNG the turn (box created, exec
  // never returned). The guard must fail loud instead of looping.
  test("(5) re-entrancy guard: a resolver returning the proxy itself throws, never hangs", async () => {
    let proxy: RoutingSandboxSession;
    proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 1 }),
      resolveActiveBackend: async (): Promise<ResolvedActiveBackend> => ({
        session: proxy as unknown as RoutableBackendSession,
        sandboxId: null,
        kind: "unprovisioned",
      }),
    });
    await expect(proxy.exec({ cmd: "x" })).rejects.toThrow(/re-entrancy|proxy itself/i);
  });

  // REGRESSION (issue #341 §5.2 / invariant E): the per-op cache was keyed by
  // active_epoch ALONE, but a pointer can change its target id WITHOUT an epoch
  // bump — the `sessions.active_sandbox_id` FK is `ON DELETE SET NULL`, so a cascade
  // that deletes the pointed-at sandbox nulls the id at the SAME epoch. Keying on the
  // epoch alone kept serving the deleted backend for that epoch (a swap-free route to
  // the Shape-3 symptom: activeSandboxId:null in the list, ops still hitting the dead
  // box). The cache must key on the FULL tuple (activeEpoch, activeSandboxId) so a
  // same-epoch id change invalidates it and the next op re-resolves.
  test("(6) cache key (epoch, sandboxId): a same-epoch target-id change invalidates the cache and re-resolves the HOME", async () => {
    const group = new FakeBackend("group-modal");
    const sibling = new FakeBackend("stale-sibling");
    // A pointer whose id can change WITHOUT bumping the epoch (the FK SET NULL shape).
    let pointer: ActivePointer = { activeSandboxId: "sbx-sibling", activeEpoch: 4 };
    let resolves = 0;
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ ...pointer }),
      resolveActiveBackend: async (p): Promise<ResolvedActiveBackend> => {
        resolves += 1;
        return p.activeSandboxId === null
          ? { session: group, sandboxId: null, kind: "modal" }
          : { session: sibling, sandboxId: p.activeSandboxId, kind: "modal" };
      },
    });

    // Op 1 resolves the sibling target at epoch 4.
    expect(((await proxy.exec({ cmd: "a" })) as { stdout: string }).stdout).toBe("stale-sibling");
    expect(resolves).toBe(1);

    // The FK nulls the pointer id at the SAME epoch (no bump) — as an ON DELETE SET
    // NULL cascade would. The NEXT op must NOT keep serving the cached sibling.
    pointer = { activeSandboxId: null, activeEpoch: 4 };
    expect(((await proxy.exec({ cmd: "b" })) as { stdout: string }).stdout).toBe("group-modal");
    expect(resolves).toBe(2);

    // The stale sibling never saw the second op; the home box did.
    expect(sibling.calls).toEqual(["a"]);
    expect(group.calls).toEqual(["b"]);
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
    const exec = await (r.session as { exec: (a: unknown) => Promise<{ stdout: string }> }).exec({
      cmd: "echo $HOSTNAME",
    });
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
    const manifest = (
      r.session as {
        state: {
          manifest: { resolveEnvironment(): Promise<Record<string, string>>; root: string };
        };
      }
    ).state.manifest;
    expect(await manifest.resolveEnvironment()).toEqual(env);
    expect(manifest.root).toBe("/workspace");
  });

  test("pinnedSelfhosted (Stage D machine-primary): the machine pointer returns the SAME pinned instance; an epoch move builds fresh", async () => {
    // The instance-identity pin: a machine-primary turn pre-establishes ONE
    // SelfhostedSession and pins it for the steady-state machine pointer so the
    // turn-start manifest write (via the proxy's `state` getter) and the per-op reads
    // hit that SAME object — never a second, divergent SelfhostedSession.
    const pinnedInstance = new FakeBackend("pinned-machine");
    let freshBuilds = 0;
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: pinnedInstance,
      defaultKind: "selfhosted",
      getSandbox: async (id) => {
        freshBuilds += 1; // a fresh build always goes through getSandbox first
        return sandboxes[id] ?? null;
      },
      controlRpcFactory: () => new MockAgentResponder({ hostname: "rebuilt" }),
      relay: RELAY,
      pinnedSelfhosted: { sandboxId: "sbx-self", epoch: 7, session: pinnedInstance },
    });

    // Steady state (sbx-self @ epoch 7) → the SAME pinned instance, twice, with NO
    // getSandbox/build (the pin short-circuits BEFORE getSandbox).
    const a = await resolve({ activeSandboxId: "sbx-self", activeEpoch: 7 });
    const b = await resolve({ activeSandboxId: "sbx-self", activeEpoch: 7 });
    expect(a.session).toBe(pinnedInstance);
    expect(b.session).toBe(pinnedInstance);
    expect(a.kind).toBe("selfhosted");
    expect(a.sandboxId).toBe("sbx-self");
    expect(freshBuilds).toBe(0);

    // A swap-back at a MOVED epoch (8) no longer matches the pin → a fresh
    // SelfhostedSession fenced under the new epoch (the stale pinned instance, fenced
    // at epoch 7, must NOT be reused).
    const c = await resolve({ activeSandboxId: "sbx-self", activeEpoch: 8 });
    expect(c.session).not.toBe(pinnedInstance);
    expect(c.kind).toBe("selfhosted");
    expect(freshBuilds).toBe(1);

    // The null (group) pointer still routes to the default backend unchanged.
    const d = await resolve({ activeSandboxId: null, activeEpoch: 7 });
    expect(d.session).toBe(pinnedInstance);
    expect(d.sandboxId).toBeNull();
  });

  test("modal swap target with no establisher -> unresolvable, typed unsupported_backend_context", async () => {
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async (id) => sandboxes[id] ?? null,
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    const err = await resolve({ activeSandboxId: "sbx-modal", activeEpoch: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ActiveBackendUnresolvableError);
    expect((err as ActiveBackendUnresolvableError).code).toBe("unsupported_backend_context");
  });

  test("unknown sandbox id -> unresolvable, typed stale_pointer (issue #341 typed diagnostics)", async () => {
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async () => null,
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    const err = await resolve({ activeSandboxId: "ghost", activeEpoch: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ActiveBackendUnresolvableError);
    expect((err as ActiveBackendUnresolvableError).code).toBe("stale_pointer");
    expect((err as Error).message).toMatch(/not found/);
  });

  test("selfhosted target missing an enrollment -> typed offline_enrollment", async () => {
    const resolve = makeActiveBackendResolver({
      workspaceId: WS,
      defaultBackend: new FakeBackend("group-modal"),
      defaultKind: "modal",
      getSandbox: async () => ({
        id: "sbx-orphan",
        kind: "selfhosted",
        name: "unpaired",
        enrollmentId: null,
      }),
      controlRpcFactory: () => new MockAgentResponder(),
      relay: RELAY,
    });
    const err = await resolve({ activeSandboxId: "sbx-orphan", activeEpoch: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ActiveBackendUnresolvableError);
    expect((err as ActiveBackendUnresolvableError).code).toBe("offline_enrollment");
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
    const proxy = new RoutingSandboxSession({
      readPointer: ptr.read,
      resolveActiveBackend: resolve,
    });

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

describe("swapTargetEstablishability — the shared admission/establishment predicate (issue #341 invariant A)", () => {
  test("the session's own group box is always establishable (it is the null/home target)", () => {
    expect(swapTargetEstablishability({ kind: "modal", isSessionGroup: true })).toEqual({
      ok: true,
    });
    expect(swapTargetEstablishability({ kind: "selfhosted", isSessionGroup: true })).toEqual({
      ok: true,
    });
  });

  test("a selfhosted machine target is establishable (liveness is admission's separate gate)", () => {
    expect(swapTargetEstablishability({ kind: "selfhosted", isSessionGroup: false })).toEqual({
      ok: true,
    });
  });

  test("a NON-group modal target is NOT establishable → unsupported_backend_context (Shape 1)", () => {
    const r = swapTargetEstablishability({ kind: "modal", isSessionGroup: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("unsupported_backend_context");
      expect(r.reason).toMatch(/Modal sandbox other than this session/i);
    }
  });

  test("an unknown backend kind is NOT establishable", () => {
    const r = swapTargetEstablishability({ kind: "daytona", isSessionGroup: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("unsupported_backend_context");
    }
  });
});

describe("RoutingSandboxSession — native-desktop surface (machine-primary computer-use)", () => {
  test("proxy fronting a native-capable default backend duck-types as native + dispatches desktopInput/screenshot to the active backend", async () => {
    // The bug: a machine-primary session routes computer-use through the proxy, but
    // the proxy did not forward desktopInput/screenshot → isNativeDesktopSession failed
    // → the capability bound the Linux exec-shelling SandboxComputer onto the Mac.
    const native = new NativeFakeBackend("selfhosted");
    const ptr = mutablePointer({ activeSandboxId: "sbx-self", activeEpoch: 1 });
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: native, sandboxId: "sbx-self", kind: "selfhosted" },
      readPointer: ptr.read,
      resolveActiveBackend: async () => ({
        session: native,
        sandboxId: "sbx-self",
        kind: "selfhosted",
      }),
    });

    // The REAL discriminator selects the native computer for this proxy.
    expect(isNativeDesktopSession(proxy as never)).toBe(true);

    // desktopInput dispatches to the active backend, carrying the event through.
    const event = { $case: "pointer", pointer: { x: 12, y: 34, action: "click", button: "left" } };
    await proxy.desktopInput!(event);
    expect(native.desktopEvents).toEqual([event]);

    // screenshot dispatches and returns the backend's frame.
    const shot = await proxy.screenshot!();
    expect(native.screenshots).toBe(1);
    expect(shot).toEqual(native.frame);
  });

  test("proxy fronting a Modal-like default backend (no native surface) does NOT duck-type as native (regression: Modal misclassification)", async () => {
    // A Modal box has no desktopInput/screenshot. The proxy must NOT expose them
    // (presence is the selection signal), or every Modal-fronting proxy would be
    // misclassified as native and driven with CGEvent/screenshot ops it can't serve.
    const modal = new FakeBackend("modal");
    const ptr = mutablePointer();
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: modal, sandboxId: null, kind: "modal" },
      readPointer: ptr.read,
      resolveActiveBackend: async () => ({ session: modal, sandboxId: null, kind: "modal" }),
    });

    expect(isNativeDesktopSession(proxy as never)).toBe(false);
    expect(typeof proxy.desktopInput).toBe("undefined");
    expect(typeof proxy.screenshot).toBe("undefined");
  });

  test("mid-turn cross-kind swap: default native, pointer swaps to a NON-native backend → screenshot() rejects RoutingUnsupportedError", async () => {
    // The proxy exposes the native surface (default backend was native), but a
    // mid-turn swap repoints to a Modal box with no screenshot. Rather than silently
    // shelling Linux tools onto a Mac (or crashing opaquely), dispatch surfaces a
    // legible RoutingUnsupportedError the caller can report as a tool failure.
    const native = new NativeFakeBackend("selfhosted");
    const modal = new FakeBackend("modal");
    const ptr = mutablePointer({ activeSandboxId: "sbx-self", activeEpoch: 1 });
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: native, sandboxId: "sbx-self", kind: "selfhosted" },
      readPointer: ptr.read,
      resolveActiveBackend: async (pointer): Promise<ResolvedActiveBackend> =>
        pointer.activeSandboxId === "sbx-self"
          ? { session: native, sandboxId: "sbx-self", kind: "selfhosted" }
          : { session: modal, sandboxId: pointer.activeSandboxId, kind: "modal" },
    });

    // Native surface is present (minted from the native default).
    expect(typeof proxy.screenshot).toBe("function");
    // First screenshot lands on the native backend.
    await proxy.screenshot!();
    expect(native.screenshots).toBe(1);

    // Swap to the non-native Modal box (epoch bump) → the NEXT screenshot rejects.
    ptr.swap("sbx-modal");
    await expect(proxy.screenshot!()).rejects.toBeInstanceOf(RoutingUnsupportedError);
  });

  test("screenshot return value passes through unchanged ({png,width,height})", async () => {
    const native = new NativeFakeBackend("selfhosted");
    const ptr = mutablePointer({ activeSandboxId: "sbx-self", activeEpoch: 1 });
    const proxy = new RoutingSandboxSession({
      defaultResolved: { session: native, sandboxId: "sbx-self", kind: "selfhosted" },
      readPointer: ptr.read,
      resolveActiveBackend: async () => ({
        session: native,
        sandboxId: "sbx-self",
        kind: "selfhosted",
      }),
    });

    const shot = await proxy.screenshot!();
    expect(shot.png).toBe(native.frame.png);
    expect(shot.width).toBe(1440);
    expect(shot.height).toBe(900);
  });
});
