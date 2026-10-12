/* ----------------------------------------------------------------------------
   useSharedQuery: the client-scoped stale-while-revalidate store behind the
   subscription account / usage surfaces. Remounts render retained rows at once,
   concurrent readers share one request, invalidation re-reads mounted entries
   and evicts unmounted ones, failures are never served as cached data, and a
   different client never sees another client's rows.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import {
  clearSharedQueries,
  invalidateSharedQueries,
  peekSharedQuery,
  setSharedQueryData,
  useSharedQuery,
  type SharedQueryOptions,
} from "../src/hooks/shared-query";
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

describe("useSharedQuery", () => {
  test("a remount renders retained data at once without loading or a second read", async () => {
    const scope = {};
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
  });

  test("stale retained data stays on screen while one background read replaces it", async () => {
    const scope = {};
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
  });

  test("concurrent readers of one key share a single request", async () => {
    const scope = {};
    const gate = deferred<string>();
    const { state, load } = counter(() => gate.promise);
    const a = await mount(scope, ["accounts"], load);
    const b = await mount(scope, ["accounts"], load);
    expect(a.result.current.loading).toBe(true);
    expect(b.result.current.loading).toBe(true);
    await actRun(async () => gate.resolve("rows"));
    await flush();
    expect(a.result.current.data).toBe("rows");
    expect(b.result.current.data).toBe("rows");
    expect(state.reads).toBe(1);
    await a.unmount();
    await b.unmount();
  });

  test("a read in flight at unmount still lands for the next mount", async () => {
    const scope = {};
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

  test("invalidation re-reads mounted entries and evicts unmounted ones", async () => {
    const scope = {};
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
  });

  test("another client never sees retained rows; clearing a client drops them", async () => {
    const alice = {};
    const bob = {};
    const aliceRows = counter(() => "alice-rows");
    const bobGate = deferred<string>();
    const bobRows = counter(() => bobGate.promise);
    const first = await mount(alice, ["accounts", "w1"], aliceRows.load);
    await flush();
    await first.unmount();

    const other = await mount(bob, ["accounts", "w1"], bobRows.load);
    expect(other.result.current.data).toBeNull();
    expect(other.result.current.loading).toBe(true);
    await actRun(async () => bobGate.resolve("bob-rows"));
    await flush();
    expect(other.result.current.data).toBe("bob-rows");
    await other.unmount();

    clearSharedQueries(alice);
    expect(peekSharedQuery(alice, ["accounts", "w1"])).toBeNull();
    expect(peekSharedQuery<string>(bob, ["accounts", "w1"])?.data).toBe("bob-rows");
  });

  test("a failure is never served as fresh data and a refusal drops retained rows", async () => {
    const scope = {};
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
  });

  test("written data reaches mounted readers and supersedes an older read in flight", async () => {
    const scope = {};
    const gate = deferred<string>();
    const { load } = counter(() => gate.promise);
    const hook = await mount(scope, ["live-usage"], load);
    await actRun(async () => setSharedQueryData(scope, ["live-usage"], "written"));
    expect(hook.result.current.data).toBe("written");
    await actRun(async () => gate.resolve("older read"));
    await flush();
    expect(hook.result.current.data).toBe("written");
    await hook.unmount();
  });

  test("a disabled reader never reads", async () => {
    const scope = {};
    const { state, load } = counter(() => "rows");
    const hook = await mount(scope, ["accounts"], load, { enabled: false });
    await flush();
    expect(state.reads).toBe(0);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.data).toBeNull();
    await hook.unmount();
  });
});
