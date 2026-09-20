import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
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

test("retry preserves successful content on transient failures but discards it when access is denied", async () => {
  let failure: Error | null = null;
  const load = async () => {
    if (failure) throw failure;
    return "loaded title";
  };
  let state!: ReturnType<typeof useSessionSearchResource<string>>;
  function Probe() {
    state = useSessionSearchResource("request", load, true, 0);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const flush = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  try {
    await act(async () => root.render(<Probe />));
    await flush();
    expect(state.value).toBe("loaded title");
    failure = new OpenGeniApiError(503, "sensitive diagnostic");
    await act(async () => state.retry());
    expect(state.value).toBe("loaded title");
    await flush();
    expect(state.value).toBe("loaded title");
    expect(state.error).not.toContain("sensitive");
    expect(state.accessDenied).toBe(false);
    failure = new OpenGeniApiError(403, "access revoked");
    await act(async () => state.retry());
    await flush();
    expect(state.value).toBeNull();
    expect(state.accessDenied).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

test("superseded and disabled resource requests receive cancellation", async () => {
  const signals: AbortSignal[] = [];
  const pending = deferred();
  const load = (signal: AbortSignal) => {
    signals.push(signal);
    return pending.promise;
  };
  function Probe({ identity, enabled = true }: { identity: string; enabled?: boolean }) {
    useSessionSearchResource(identity, load, enabled, 0);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const flush = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  try {
    await act(async () => root.render(<Probe identity="first" />));
    await flush();
    await act(async () => root.render(<Probe identity="second" />));
    expect(signals[0]!.aborted).toBe(true);
    await flush();
    expect(signals[1]!.aborted).toBe(false);
    await act(async () => root.render(<Probe identity="second" enabled={false} />));
    expect(signals[1]!.aborted).toBe(true);
    await act(async () => pending.resolve("late response"));
  } finally {
    await act(async () => root.unmount());
  }
});

test("a synchronous loader failure is a retryable visible error, not an unhandled rejection", async () => {
  const load = (): Promise<string> => {
    throw new Error("loader failed");
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
    expect(state.loading).toBe(false);
    expect(state.error).toBe("Search could not be loaded. Try again.");
  } finally {
    await act(async () => root.unmount());
  }
});
