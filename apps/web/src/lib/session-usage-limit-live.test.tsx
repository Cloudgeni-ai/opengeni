// The one live reader of a task's usage (the chat route's): when it reads, and
// that it converges without the parent stream's help. A child's usage is not
// in the parent's events, so the final read on idle and the foreground poll
// are what keep the shown amount honest.
import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionUsageLimit } from "@opengeni/sdk/session-usage-limits";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  SESSION_USAGE_LIMIT_POLL_MS,
  useSessionUsageLimit,
  type UseSessionUsageLimitOptions,
} from "./session-usage-limit";

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

let visibility: DocumentVisibilityState = "visible";
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
  jest.useRealTimers();
  visibility = "visible";
});

/** A server whose usage the test moves; each read can be held open. */
function server(options: { limitMicros?: number | null } = {}) {
  const state = { usedMicros: 10_000_000, reads: 0, inflight: 0, maxInflight: 0 };
  let hold: Promise<void> | null = null;
  const client = {
    async getSessionUsageLimit(): Promise<SessionUsageLimit> {
      state.reads += 1;
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      const usedMicros = state.usedMicros;
      const revision = state.reads;
      try {
        if (hold) await hold;
      } finally {
        state.inflight -= 1;
      }
      return {
        basis: "model_api_equivalent_v1",
        rootSessionId: "root",
        inherited: false,
        status: "within",
        limitMicros: options.limitMicros === undefined ? 50_000_000 : options.limitMicros,
        usedMicros,
        version: 1,
        usageRevision: revision,
        history: "complete",
        coverage: "complete",
        pricedCalls: revision,
        freeCalls: 0,
        unpricedCalls: 0,
        updatedAt: "2026-10-13T12:00:00.000Z",
      } as SessionUsageLimit;
    },
  };
  return {
    client,
    state,
    holdReads() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        hold = null;
        release();
      };
    },
  };
}

type Live = NonNullable<UseSessionUsageLimitOptions["live"]>;

function Probe(props: { client: object; live: Partial<Live> }) {
  const state = useSessionUsageLimit({
    client: props.client as UseSessionUsageLimitOptions["client"],
    workspaceId: "workspace",
    sessionId: "root",
    enabled: true,
    live: { events: [], active: false, connectionState: "live", ...props.live },
  });
  return createElement("output", {}, String(state.usage?.usedMicros));
}

async function mount(client: object, live: Partial<Live>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(Probe, { client, live })));
}

async function rerender(client: object, live: Partial<Live>) {
  await act(async () => root!.render(createElement(Probe, { client, live })));
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => undefined);
}

function shown(): string {
  return container?.textContent ?? "";
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
}

test("going from active to idle does a final read (the parent's repro)", async () => {
  const { client, state } = server();
  await mount(client, { active: false });
  expect(state.reads).toBe(1);
  await rerender(client, { active: true });
  state.usedMicros = 15_000_000;
  // The child finishes before the first interval; the parent emits no model usage.
  await rerender(client, { active: false });
  expect(state.reads).toBe(2);
  expect(shown()).toBe("15000000");
});

test("a child shorter than one interval still shows within 30 seconds in the foreground", async () => {
  jest.useFakeTimers();
  setVisibility("visible");
  // No limit, and the parent never looks active: only the agents keep it watched.
  const { client, state } = server({ limitMicros: null });
  await mount(client, { active: false, watch: true });
  expect(state.reads).toBe(1);
  state.usedMicros = 15_000_000; // a child started and finished unseen
  await advance(SESSION_USAGE_LIMIT_POLL_MS);
  expect(state.reads).toBe(2);
  expect(shown()).toBe("15000000");
});

test("with a limit set, an idle task keeps converging; without agents or a limit it doesn't poll", async () => {
  jest.useFakeTimers();
  setVisibility("visible");
  const limited = server();
  await mount(limited.client, { active: false });
  limited.state.usedMicros = 20_000_000;
  await advance(SESSION_USAGE_LIMIT_POLL_MS);
  expect(limited.state.reads).toBe(2);
  expect(shown()).toBe("20000000");
  await act(async () => root!.unmount());
  root = null;

  const unlimited = server({ limitMicros: null });
  await mount(unlimited.client, { active: false });
  await advance(SESSION_USAGE_LIMIT_POLL_MS * 3);
  expect(unlimited.state.reads).toBe(1);
});

test("hidden pages skip the poll; becoming visible reads once", async () => {
  jest.useFakeTimers();
  setVisibility("hidden");
  const { client, state } = server();
  await mount(client, { active: true });
  expect(state.reads).toBe(1);
  state.usedMicros = 18_000_000;
  await advance(SESSION_USAGE_LIMIT_POLL_MS * 2);
  expect(state.reads).toBe(1);
  expect(shown()).toBe("10000000");
  setVisibility("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => undefined);
  expect(state.reads).toBe(2);
  expect(shown()).toBe("18000000");
});

test("reconnecting after a drop reads once", async () => {
  const { client, state } = server();
  await mount(client, { active: false, connectionState: "live" });
  await rerender(client, { active: false, connectionState: "reconnecting" });
  expect(state.reads).toBe(1);
  state.usedMicros = 22_000_000;
  await rerender(client, { active: false, connectionState: "live" });
  await act(async () => undefined);
  expect(state.reads).toBe(2);
  expect(shown()).toBe("22000000");
});

test("reads never overlap: a read asked for mid-flight runs once, right after", async () => {
  const { client, state, holdReads } = server();
  const release = holdReads();
  await mount(client, { active: true });
  expect(state.inflight).toBe(1);
  // The tree goes idle while the first read is still open: its answer may
  // predate the child's last usage, so one more read follows it.
  state.usedMicros = 15_000_000;
  await rerender(client, { active: false });
  await rerender(client, { active: true });
  await rerender(client, { active: false });
  expect(state.inflight).toBe(1);
  await act(async () => release());
  await act(async () => undefined);
  expect(state.maxInflight).toBe(1);
  expect(state.reads).toBe(2);
  expect(shown()).toBe("15000000");
});

test("a child completing on the parent's stream reads after the debounce", async () => {
  jest.useFakeTimers();
  const { client, state } = server({ limitMicros: null });
  await mount(client, { active: false, events: [] });
  state.usedMicros = 16_000_000;
  const childDone = {
    type: "system.update.delivered",
    sequence: 9,
    payload: {
      members: [{ id: "update-1", kind: "child_terminal_result", classification: "success" }],
    },
  } as unknown as Live["events"][number];
  await rerender(client, { active: false, events: [childDone] });
  expect(state.reads).toBe(1);
  await advance(1_000);
  expect(state.reads).toBe(2);
  expect(shown()).toBe("16000000");
});
