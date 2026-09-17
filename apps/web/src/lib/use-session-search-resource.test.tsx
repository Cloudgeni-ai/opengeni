import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useSessionSearchResource } from "./use-session-search-resource";

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}

test("search hides old authority data immediately and rejects stale responses", async () => {
  const first = deferred();
  const second = deferred();
  const loadFirst = () => first.promise;
  const loadSecond = () => second.promise;
  let state!: ReturnType<typeof useSessionSearchResource<string>>;
  function Probe({
    identity,
    load,
    enabled = true,
  }: {
    identity: string;
    load: () => Promise<string>;
    enabled?: boolean;
  }) {
    state = useSessionSearchResource(identity, load, enabled, 0);
    return <div>{state.value ?? (state.loading ? "loading" : state.error)}</div>;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Probe identity="first" load={loadFirst} />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await act(async () => root.render(<Probe identity="second" load={loadSecond} />));
    expect(state.value).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await act(async () => second.resolve("authorized second result"));
    expect(state.value).toBe("authorized second result");
    await act(async () => first.resolve("stale first result"));
    expect(state.value).toBe("authorized second result");
    await act(async () =>
      root.render(<Probe identity="another authority" load={loadSecond} enabled={false} />),
    );
    expect(state.value).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

test("failures remain distinguishable from empty results and retry is available", async () => {
  let attempts = 0;
  const load = async () => {
    if (++attempts === 1) throw new Error("sensitive server diagnostic");
    return "found";
  };
  let state!: ReturnType<typeof useSessionSearchResource<string>>;
  function Probe() {
    state = useSessionSearchResource("request", load, true, 0);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(state.error).toBe("Search could not be loaded. Try again.");
    expect(state.loading).toBe(false);
    await act(async () => state.retry());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(state.value).toBe("found");
    expect(state.error).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
