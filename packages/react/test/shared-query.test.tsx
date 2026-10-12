/* ----------------------------------------------------------------------------
   useSharedQuery: the client-scoped stale-while-revalidate store behind the
   subscription account / usage surfaces.

   - Default (no host opt-in): readers mounted together share one request, but
     nothing is served to a later mount.
   - Retained scope (OpenGeniProvider `retainReadsAcrossMounts`, or the console
     retaining its own client): remounts render retained rows at once and
     re-read in the background; releasing the scope clears it.
   - Loaders are bound to their key on commit; invalidation supersedes reads in
     flight; clear resets mounted readers in place; failures are never cached.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { act, StrictMode, startTransition, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  clearSharedQueries,
  invalidateSharedQueries,
  peekSharedQuery,
  retainSharedQueries,
  sharedQueryWriter,
  useSharedQuery,
  useSharedQueryValue,
  type SharedQueryOptions,
} from "../src/hooks/shared-query";
import { OpenGeniProvider } from "../src/provider";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function counter<T>(next: () => T | Promise<T>) {
  const state = { reads: 0 };
  const load = async () => {
    state.reads += 1;
    return await next();
  };
  return { state, load };
}

async function mount<T>(
  scope: object,
  key: readonly string[],
  load: () => Promise<T>,
  options: SharedQueryOptions = {},
) {
  return await renderHook(() => useSharedQuery(scope, key, load, options), undefined);
}

/** A scope the host opted into keeping across mounts (released by the caller). */
function retainedScope() {
  const scope = {};
  const release = retainSharedQueries(scope);
  return { scope, release };
}

async function renderTree(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    rerender: (next: ReactNode) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useSharedQuery — default scope (no host opt-in)", () => {
  test("readers mounted together share one request; a later mount reads again", async () => {
    const scope = {};
    const gate = deferred<string>();
    const { state, load } = counter<string>((): string | Promise<string> =>
      state.reads === 1 ? gate.promise : "second",
    );
    const a = await mount(scope, ["accounts"], load);
    const b = await mount(scope, ["accounts"], load);
    await actRun(async () => gate.resolve("rows"));
    await flush();
    expect(a.result.current.data).toBe("rows");
    expect(b.result.current.data).toBe("rows");
    expect(state.reads).toBe(1);
    await a.unmount();
    await b.unmount();
    await flush();

    // Nothing outlives its readers: the next mount never sees the old rows.
    expect(peekSharedQuery(scope, ["accounts"])).toBeNull();
    const rendered: unknown[] = [];
    const again = await renderHook(() => {
      const result = useSharedQuery(scope, ["accounts"], load);
      rendered.push(result.data);
      return result;
    }, undefined);
    await flush();
    expect(rendered).not.toContain("rows");
    expect(again.result.current.data).toBe("second");
    expect(state.reads).toBe(2);
    await again.unmount();
  });

  test("a read in flight at the last unmount is discarded", async () => {
    const scope = {};
    const gate = deferred<string>();
    const { load } = counter(() => gate.promise);
    const first = await mount(scope, ["accounts"], load);
    await first.unmount();
    await flush();
    await actRun(async () => gate.resolve("late rows"));
    await flush();
    expect(peekSharedQuery(scope, ["accounts"])).toBeNull();
  });

  test("a write with no mounted reader is refused", async () => {
    const scope = {};
    const write = sharedQueryWriter(scope);
    expect(write(["live-usage"], "reading")).toBe(false);
    expect(peekSharedQuery(scope, ["live-usage"])).toBeNull();
  });

  test("StrictMode's double effect still performs a single read", async () => {
    const scope = {};
    const { state, load } = counter(() => "rows");
    function Probe() {
      useSharedQuery(scope, ["accounts"], load);
      return null;
    }
    const tree = await renderTree(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await flush();
    expect(state.reads).toBe(1);
    expect(peekSharedQuery<string>(scope, ["accounts"])?.data).toBe("rows");
    await tree.unmount();
  });
});

describe("useSharedQuery — retained scope", () => {
  test("a remount renders retained data at once without loading or a second read", async () => {
    const { scope, release } = retainedScope();
    const { state, load } = counter(() => ["account-a"]);
    const first = await mount(scope, ["accounts", "w1"], load);
    await flush();
    expect(first.result.current.data).toEqual(["account-a"]);
    await first.unmount();

    // Navigating back: the first render already has the rows; nothing re-reads
    // inside the freshness window.
    const second = await mount(scope, ["accounts", "w1"], load);
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.data).toEqual(["account-a"]);
    await flush();
    expect(state.reads).toBe(1);
    await second.unmount();
    release();
  });

  test("stale retained data stays on screen while one background read replaces it", async () => {
    const { scope, release } = retainedScope();
    let value = "old";
    const gate = { current: null as ReturnType<typeof deferred<void>> | null };
    const { state, load } = counter(async () => {
      if (gate.current) await gate.current.promise;
      return value;
    });
    const first = await mount(scope, ["usage"], load, { staleTimeMs: 0 });
    await flush();
    await first.unmount();

    value = "new";
    gate.current = deferred<void>();
    const second = await mount(scope, ["usage"], load, { staleTimeMs: 0 });
    expect(second.result.current.data).toBe("old");
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.fetching).toBe(true);
    await actRun(async () => gate.current!.resolve());
    await flush();
    expect(second.result.current.data).toBe("new");
    expect(second.result.current.fetching).toBe(false);
    expect(state.reads).toBe(2);
    await second.unmount();
    release();
  });

  test("a read in flight at unmount still lands for the next mount", async () => {
    const { scope, release } = retainedScope();
    const gate = deferred<string>();
    const { state, load } = counter(() => gate.promise);
    const first = await mount(scope, ["accounts"], load);
    await first.unmount();
    await actRun(async () => gate.resolve("rows"));
    await flush();
    const second = await mount(scope, ["accounts"], load);
    expect(second.result.current.data).toBe("rows");
    expect(second.result.current.loading).toBe(false);
    expect(state.reads).toBe(1);
    await second.unmount();
    release();
  });

  test("a forced refresh during a read queues exactly one successor read", async () => {
    const scope = {};
    let value = 1;
    const gate = deferred<void>();
    const { state, load } = counter(async () => {
      const seen = value;
      if (state.reads === 1) await gate.promise;
      return seen;
    });
    const hook = await mount(scope, ["accounts"], load);
    value = 2; // a mutation settled after the first read started
    let first!: Promise<void>;
    let second!: Promise<void>;
    await actRun(async () => {
      first = hook.result.current.refresh();
      second = hook.result.current.refresh();
    });
    await actRun(async () => gate.resolve());
    await actRun(async () => Promise.all([first, second]));
    await flush();
    expect(state.reads).toBe(2);
    expect(hook.result.current.data).toBe(2);
    await hook.unmount();
  });

  test("a forced refresh that could not run before unmount leaves the entry for re-reading", async () => {
    const { scope, release } = retainedScope();
    let value = "before";
    const gate = deferred<void>();
    const { state, load } = counter(async () => {
      const seen = value;
      if (state.reads === 1) await gate.promise;
      return seen;
    });
    const hook = await mount(scope, ["accounts"], load);
    value = "after";
    await actRun(async () => void hook.result.current.refresh());
    await hook.unmount();
    await actRun(async () => gate.resolve());
    await flush();
    // The predecessor's rows may show, but they are not trusted as fresh.
    const rendered: unknown[] = [];
    const again = await renderHook(() => {
      const result = useSharedQuery(scope, ["accounts"], load);
      rendered.push(result.data);
      return result;
    }, undefined);
    expect(rendered[0]).toBe("before");
    await flush();
    expect(again.result.current.data).toBe("after");
    expect(state.reads).toBe(2);
    await again.unmount();
    release();
  });

  test("invalidation re-reads mounted entries and evicts unmounted ones", async () => {
    const { scope, release } = retainedScope();
    let version = 1;
    const mounted = counter(() => `session-${version}`);
    const unmounted = counter(() => `workspace-${version}`);
    const other = counter(() => `other-${version}`);
    const a = await mount(scope, ["codex", "w1", "session", "s1"], mounted.load);
    const b = await mount(scope, ["codex", "w1"], unmounted.load);
    const c = await mount(scope, ["codex", "w2"], other.load);
    await flush();
    await b.unmount();
    await c.unmount();

    version = 2;
    await actRun(() => invalidateSharedQueries(scope, ["codex", "w1"]));
    await flush();
    expect(a.result.current.data).toBe("session-2");
    expect(mounted.state.reads).toBe(2);
    // The unmounted entry for the changed workspace is gone, not shown stale.
    expect(peekSharedQuery(scope, ["codex", "w1"])).toBeNull();
    // Another workspace's entry is untouched.
    expect(peekSharedQuery<string>(scope, ["codex", "w2"])?.data).toBe("other-1");

    const rendered: unknown[] = [];
    const remount = await renderHook(() => {
      const result = useSharedQuery(scope, ["codex", "w1"], unmounted.load);
      rendered.push(result.data);
      return result;
    }, undefined);
    await flush();
    // Never the pre-mutation rows, even for one render.
    expect(rendered).not.toContain("workspace-1");
    expect(remount.result.current.data).toBe("workspace-2");
    expect(unmounted.state.reads).toBe(2);
    await a.unmount();
    await remount.unmount();
    release();
  });

  test("invalidation during a read discards that read, even if the reader then unmounts", async () => {
    const { scope, release } = retainedScope();
    const reads: ReturnType<typeof deferred<string>>[] = [];
    const load = () => {
      const read = deferred<string>();
      reads.push(read);
      return read.promise;
    };
    const hook = await mount(scope, ["accounts"], load);
    expect(reads.length).toBe(1);
    await actRun(async () => void invalidateSharedQueries(scope, ["accounts"]));
    // The invalidation started a new read right away instead of queueing.
    expect(reads.length).toBe(2);
    await hook.unmount();
    // The pre-mutation read settles after the mutation: never stored.
    await actRun(async () => reads[0]!.resolve("pre-mutation rows"));
    await flush();
    expect(peekSharedQuery(scope, ["accounts"])?.data ?? null).toBeNull();
    await actRun(async () => reads[1]!.resolve("post-mutation rows"));
    await flush();
    expect(peekSharedQuery<string>(scope, ["accounts"])?.data).toBe("post-mutation rows");
    release();
  });

  test("invalidating a paused entry with a read in flight re-reads on resume", async () => {
    const scope = {};
    const reads: ReturnType<typeof deferred<string>>[] = [];
    const load = () => {
      const read = deferred<string>();
      reads.push(read);
      return read.promise;
    };
    const hook = await renderHook(
      ({ enabled }: { enabled: boolean }) => useSharedQuery(scope, ["accounts"], load, { enabled }),
      { enabled: true },
    );
    expect(reads.length).toBe(1);
    await hook.rerender({ enabled: false });
    await actRun(() => invalidateSharedQueries(scope, ["accounts"]));
    await hook.rerender({ enabled: true });
    // Resume starts a new read instead of joining the superseded one.
    expect(reads.length).toBe(2);
    expect(hook.result.current.loading).toBe(true);
    await actRun(async () => reads[0]!.resolve("superseded"));
    await actRun(async () => reads[1]!.resolve("current"));
    await flush();
    expect(hook.result.current.data).toBe("current");
    expect(hook.result.current.loading).toBe(false);
    await hook.unmount();
  });

  test("a failure is never served as fresh data and a refusal drops retained rows", async () => {
    const { scope, release } = retainedScope();
    let outcome: "ok" | "outage" | "refused" = "ok";
    const { state, load } = counter(async () => {
      if (outcome === "outage") throw new Error("upstream unavailable");
      if (outcome === "refused") throw Object.assign(new Error("Forbidden"), { status: 403 });
      return "rows";
    });
    const hook = await mount(scope, ["accounts"], load, { staleTimeMs: 60_000 });
    await flush();

    outcome = "outage";
    await actRun(() => hook.result.current.refresh());
    await flush();
    // A transient failure keeps the rows beside the error for the caller to judge.
    expect(hook.result.current.data).toBe("rows");
    expect(hook.result.current.error?.message).toBe("upstream unavailable");
    await hook.unmount();

    // The failed entry is not fresh: a remount re-reads instead of trusting it,
    // and it does not inherit the old error while doing so.
    outcome = "ok";
    const again = await mount(scope, ["accounts"], load, { staleTimeMs: 60_000 });
    expect(again.result.current.error).toBeNull();
    await flush();
    expect(state.reads).toBe(3);
    expect(again.result.current.data).toBe("rows");

    outcome = "refused";
    await actRun(() => again.result.current.refresh());
    await flush();
    expect(again.result.current.data).toBeNull();
    expect(again.result.current.error?.message).toBe("Forbidden");
    await again.unmount();
    release();
  });

  test("written data reaches mounted readers and supersedes an older read in flight", async () => {
    const scope = {};
    const gate = deferred<string>();
    const { state, load } = counter<string>((): string | Promise<string> =>
      state.reads === 1 ? gate.promise : "re-read",
    );
    const hook = await mount(scope, ["live-usage"], load);
    const write = sharedQueryWriter(scope);
    await actRun(async () => write(["live-usage"], "written"));
    expect(hook.result.current.data).toBe("written");
    await actRun(async () => gate.resolve("older read"));
    await flush();
    expect(hook.result.current.data).toBe("written");
    // The superseded read no longer blocks a new one.
    await actRun(() => hook.result.current.refresh());
    await flush();
    expect(hook.result.current.data).toBe("re-read");
    await hook.unmount();
  });

  test("a subscribe-only reader renders writes and keeps the entry while mounted", async () => {
    const scope = {};
    const reader = await renderHook(() => useSharedQueryValue<string>(scope, ["live"]), undefined);
    expect(reader.result.current.data).toBeNull();
    await actRun(async () => sharedQueryWriter(scope)(["live"], "reading"));
    expect(reader.result.current.data).toBe("reading");
    await reader.unmount();
    await flush();
    expect(peekSharedQuery(scope, ["live"])).toBeNull();
  });

  test("a disabled reader never reads and shows no retained rows", async () => {
    const { scope, release } = retainedScope();
    const { state, load } = counter(() => "rows");
    const reader = await mount(scope, ["accounts"], load);
    await flush();
    await reader.unmount();
    expect(state.reads).toBe(1);

    const hook = await mount(scope, ["accounts"], load, { enabled: false });
    await flush();
    expect(state.reads).toBe(1);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.data).toBeNull();
    await hook.unmount();
    release();
  });
});

describe("useSharedQuery — loader binding", () => {
  function keyedLoaders() {
    const calls: string[] = [];
    const loaders = new Map<string, () => Promise<string>>();
    const loaderFor = (key: string) => {
      let load = loaders.get(key);
      if (!load) {
        load = async () => {
          calls.push(key);
          return `${key}-rows-${calls.filter((each) => each === key).length}`;
        };
        loaders.set(key, load);
      }
      return load;
    };
    return { calls, loaderFor };
  }

  test("a key change never lets the new key's loader fill the old key's entry", async () => {
    const { scope, release } = retainedScope();
    const { calls, loaderFor } = keyedLoaders();
    const hook = await renderHook(
      ({ k }: { k: string }) => useSharedQuery(scope, ["q", k], loaderFor(k)),
      { k: "A" },
    );
    await flush();
    expect(hook.result.current.data).toBe("A-rows-1");

    // Commit the switch to B through layout effects only: the A subscription
    // is still registered (passive cleanup hasn't run) when A is re-read, as
    // with a poll, an event refresh or a trailing read landing right then.
    await hook.rerenderThroughLayout({ k: "B" });
    void invalidateSharedQueries(scope, ["q", "A"]);
    await flush();
    expect(calls.filter((each) => each === "A").length).toBe(1);
    expect(peekSharedQuery<string>(scope, ["q", "A"])?.data ?? null).not.toBe("B-rows-1");
    expect(hook.result.current.data).toBe("B-rows-1");
    // B's loader only ever read B.
    expect(calls).toEqual(["A", "B"]);
    await hook.unmount();
    release();
  });

  test("a render that never commits does not rebind the committed key's loader", async () => {
    const { scope, release } = retainedScope();
    const { calls, loaderFor } = keyedLoaders();
    const never = new Promise<never>(() => undefined);
    function Probe({ k, suspend }: { k: string; suspend: boolean }) {
      const { data } = useSharedQuery(scope, ["q", "session"], loaderFor(k));
      if (suspend) throw never;
      return <span>{data}</span>;
    }
    const tree = await renderTree(
      <Suspense fallback={null}>
        <Probe k="A" suspend={false} />
      </Suspense>,
    );
    await flush();
    // A navigation renders the next session in a transition that suspends:
    // React keeps the committed (A) tree and discards this render.
    await act(async () =>
      startTransition(() =>
        tree.rerender(
          <Suspense fallback={null}>
            <Probe k="B" suspend />
          </Suspense>,
        ),
      ),
    );
    await actRun(() => invalidateSharedQueries(scope, ["q", "session"]));
    await flush();
    expect(calls).toEqual(["A", "A"]);
    expect(peekSharedQuery<string>(scope, ["q", "session"])?.data).toBe("A-rows-2");
    await tree.unmount();
    release();
  });
});

describe("useSharedQuery — polling", () => {
  test("polls at the shortest subscriber interval and stops with its subscriber", async () => {
    const scope = {};
    const { state, load } = counter(() => "rows");
    const slow = await mount(scope, ["accounts"], load, { pollIntervalMs: 60_000 });
    const fast = await mount(scope, ["accounts"], load, { pollIntervalMs: 25 });
    await flush(200);
    expect(state.reads).toBeGreaterThanOrEqual(3);
    await fast.unmount();
    const afterFast = state.reads;
    await flush(200);
    // Only the slow interval remains: no further reads in this window.
    expect(state.reads).toBeLessThanOrEqual(afterFast + 1);
    await slow.unmount();
  });

  test("polls only while the page is visible", async () => {
    const scope = {};
    const { state, load } = counter(() => "rows");
    const hook = await mount(scope, ["accounts"], load, { pollIntervalMs: 25 });
    try {
      await flush(100);
      expect(state.reads).toBeGreaterThanOrEqual(2);
      await actRun(async () => setVisibility("hidden"));
      // The hidden-page grace period, then nothing.
      await flush(2_200);
      const whileHidden = state.reads;
      await flush(200);
      expect(state.reads).toBe(whileHidden);
      await actRun(async () => setVisibility("visible"));
      await flush(150);
      expect(state.reads).toBeGreaterThan(whileHidden);
    } finally {
      await actRun(async () => setVisibility("visible"));
      await hook.unmount();
    }
  });
});

describe("clearSharedQueries and identity boundaries", () => {
  test("another client never sees retained rows", async () => {
    const alice = retainedScope();
    const bob = retainedScope();
    const aliceRows = counter(() => "alice-rows");
    const bobGate = deferred<string>();
    const bobRows = counter(() => bobGate.promise);
    const first = await mount(alice.scope, ["accounts", "w1"], aliceRows.load);
    await flush();
    await first.unmount();

    const other = await mount(bob.scope, ["accounts", "w1"], bobRows.load);
    expect(other.result.current.data).toBeNull();
    expect(other.result.current.loading).toBe(true);
    await actRun(async () => bobGate.resolve("bob-rows"));
    await flush();
    expect(other.result.current.data).toBe("bob-rows");
    await other.unmount();

    clearSharedQueries(alice.scope);
    expect(peekSharedQuery(alice.scope, ["accounts", "w1"])).toBeNull();
    expect(peekSharedQuery<string>(bob.scope, ["accounts", "w1"])?.data).toBe("bob-rows");
    alice.release();
    bob.release();
  });

  test("clearing while readers stay mounted resets them in place and they read again", async () => {
    const { scope, release } = retainedScope();
    let person = "alice";
    const gate = { current: null as ReturnType<typeof deferred<void>> | null };
    const { state, load } = counter(async () => {
      const reading = `${person}-rows`;
      if (gate.current) await gate.current.promise;
      return reading;
    });
    const hook = await mount(scope, ["accounts"], load);
    await flush();
    expect(hook.result.current.data).toBe("alice-rows");

    person = "bob";
    gate.current = deferred<void>();
    await actRun(async () => clearSharedQueries(scope));
    // The previous person's rows are gone at once; the reader is loading again.
    expect(hook.result.current.data).toBeNull();
    expect(hook.result.current.loading).toBe(true);
    expect(state.reads).toBe(2);
    await actRun(async () => gate.current!.resolve());
    await flush();
    expect(hook.result.current.data).toBe("bob-rows");
    expect(hook.result.current.loading).toBe(false);
    // Still subscribed: refresh works.
    await actRun(() => hook.result.current.refresh());
    expect(state.reads).toBe(3);
    await hook.unmount();
    release();
  });

  test("a write that began before a clear is refused and never resurrects the scope", async () => {
    const { scope, release } = retainedScope();
    const write = sharedQueryWriter(scope);
    clearSharedQueries(scope);
    expect(write(["live-usage"], "previous person's reading")).toBe(false);
    expect(peekSharedQuery(scope, ["live-usage"])).toBeNull();
    // A writer created after the clear still records.
    expect(sharedQueryWriter(scope)(["live-usage"], "reading")).toBe(true);
    release();
    await flush();
    // Releasing the last retention clears the scope.
    expect(peekSharedQuery(scope, ["live-usage"])).toBeNull();
  });

  test("the provider opt-in retains across mounts and a client change drops the old client's rows", async () => {
    const alice = fakeClient({});
    const bob = fakeClient({});
    const loads = { alice: 0, bob: 0 };
    function Accounts({ client, name }: { client: object; name: "alice" | "bob" }) {
      const { data } = useSharedQuery(client, ["accounts"], async () => {
        loads[name] += 1;
        return `${name}-rows`;
      });
      return <span>{data}</span>;
    }
    const page = (client: ReturnType<typeof fakeClient>, name: "alice" | "bob", show: boolean) => (
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID} retainReadsAcrossMounts>
        {show ? <Accounts client={client} name={name} /> : null}
      </OpenGeniProvider>
    );
    const tree = await renderTree(page(alice, "alice", true));
    await flush();
    await tree.rerender(page(alice, "alice", false));
    await flush();
    // Retained across the unmount while the provider keeps the opt-in.
    expect(peekSharedQuery<string>(alice, ["accounts"])?.data).toBe("alice-rows");
    await tree.rerender(page(alice, "alice", true));
    await flush();
    expect(loads.alice).toBe(1);

    // Signing in as someone else hands the provider a new client: the old
    // client's rows are dropped and the new one starts cold.
    await tree.rerender(page(bob, "bob", true));
    await flush();
    expect(peekSharedQuery(alice, ["accounts"])).toBeNull();
    expect(peekSharedQuery<string>(bob, ["accounts"])?.data).toBe("bob-rows");
    await tree.unmount();
    await flush();
    expect(peekSharedQuery(bob, ["accounts"])).toBeNull();
  });

  test("without the provider opt-in nothing is served across mounts", async () => {
    const client = fakeClient({});
    let loads = 0;
    function Accounts() {
      const { data } = useSharedQuery(client, ["accounts"], async () => {
        loads += 1;
        return "rows";
      });
      return <span>{data}</span>;
    }
    const page = (show: boolean) => (
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
        {show ? <Accounts /> : null}
      </OpenGeniProvider>
    );
    const tree = await renderTree(page(true));
    await flush();
    await tree.rerender(page(false));
    await flush();
    expect(peekSharedQuery(client, ["accounts"])).toBeNull();
    await tree.rerender(page(true));
    await flush();
    expect(loads).toBe(2);
    await tree.unmount();
  });
});
