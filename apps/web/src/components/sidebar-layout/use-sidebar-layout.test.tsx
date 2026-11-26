import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SidebarLayoutResponse } from "@opengeni/sdk";

import {
  actRun,
  flush,
  registerDom,
  renderHook,
} from "../../../../../packages/react/test/render-hook";

const context: { client: unknown; accessContext: { subjectId: string } } = {
  client: {},
  accessContext: { subjectId: "user:ada" },
};

mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context }));

const { useSidebarLayout, resetSidebarLayoutCache, SIDEBAR_OPTIONS_WAIT_MS } =
  await import("./use-sidebar-layout");

registerDom();
afterEach(() => {
  resetSidebarLayoutCache();
  window.localStorage.clear();
  document.body.replaceChildren();
});

function layout(label: string, personal: number, workspace: number): SidebarLayoutResponse {
  return {
    items: [{ id: label, origin: "personal", type: "link", url: "https://x.example.com", label }],
    hidden: [],
    personal: { available: true, revision: personal, customized: true },
    workspace: { revision: workspace, canEdit: false },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const labels = (value: SidebarLayoutResponse | null) => value?.items.map((item) => item.label);

describe("useSidebarLayout", () => {
  test("two overlapping updates finishing out of order keep the newer answer", async () => {
    const answers = [deferred<SidebarLayoutResponse>(), deferred<SidebarLayoutResponse>()];
    let call = 0;
    context.client = {
      getSidebarLayout: mock(async () => layout("start", 1, 0)),
      updateSidebarLayout: mock(() => answers[call++]!.promise),
    };
    const hook = await renderHook(() => useSidebarLayout("w"), {});
    try {
      await flush();
      expect(labels(hook.result.current.layout)).toEqual(["start"]);
      const request = { scope: "personal" as const, changes: [{ op: "reset" as const }] };
      let first!: Promise<unknown>;
      let second!: Promise<unknown>;
      await actRun(() => {
        first = hook.result.current.update(request);
        second = hook.result.current.update(request);
      });
      await actRun(async () => {
        answers[1]!.resolve(layout("second", 3, 0));
        await second;
        answers[0]!.resolve(layout("first", 2, 0));
        await first;
      });
      expect(labels(hook.result.current.layout)).toEqual(["second"]);
    } finally {
      await hook.unmount();
    }
  });

  test("an update answer behind in the other scope reads again", async () => {
    let read = 0;
    const getSidebarLayout = mock(async () =>
      read++ === 0 ? layout("admin", 0, 1) : layout("both", 1, 1),
    );
    context.client = {
      getSidebarLayout,
      // Written on top of personal 0 while the workspace was read at 0.
      updateSidebarLayout: mock(async () => layout("mine", 1, 0)),
    };
    const hook = await renderHook(() => useSidebarLayout("w"), {});
    try {
      await flush();
      expect(labels(hook.result.current.layout)).toEqual(["admin"]);
      await actRun(async () => {
        await hook.result.current.update({ scope: "personal", changes: [{ op: "reset" }] });
      });
      await flush();
      expect(getSidebarLayout).toHaveBeenCalledTimes(2);
      expect(labels(hook.result.current.layout)).toEqual(["both"]);
    } finally {
      await hook.unmount();
    }
  });
});

describe("options before the layout arrives", () => {
  const appsOff = (): SidebarLayoutResponse => ({
    ...layout("x", 1, 0),
    options: { sessionsShowApps: false, hiddenNavEntries: ["meetings"], settingsMore: null },
  });

  test("unknown at first, so the rail waits; then remembered for the next load", async () => {
    const answer = deferred<SidebarLayoutResponse>();
    context.client = { getSidebarLayout: mock(() => answer.promise) };
    const first = await renderHook(() => useSidebarLayout("w"), {});
    try {
      expect(first.result.current.options).toBeNull();
      await actRun(async () => {
        answer.resolve(appsOff());
        await answer.promise;
      });
      await flush();
      expect(first.result.current.options?.sessionsShowApps).toBe(false);
    } finally {
      await first.unmount();
    }
    // A reload: nothing in memory, the read still under way.
    resetSidebarLayoutCache();
    context.client = { getSidebarLayout: mock(() => new Promise(() => undefined)) };
    const reload = await renderHook(() => useSidebarLayout("w"), {});
    try {
      expect(reload.result.current.layout).toBeNull();
      expect(reload.result.current.options).toEqual({
        sessionsShowApps: false,
        appsPlacement: "hidden",
        hiddenNavEntries: ["meetings"],
        settingsMore: null,
        navOrder: null,
        navSetup: null,
      });
    } finally {
      await reload.unmount();
    }
  });

  test("another person or workspace doesn't get the remembered options", async () => {
    context.client = { getSidebarLayout: mock(async () => appsOff()) };
    const hook = await renderHook(() => useSidebarLayout("w"), {});
    await flush();
    await hook.unmount();
    resetSidebarLayoutCache();
    context.client = { getSidebarLayout: mock(() => new Promise(() => undefined)) };
    const other = await renderHook(() => useSidebarLayout("other"), {});
    try {
      expect(other.result.current.options).toBeNull();
    } finally {
      await other.unmount();
    }
  });

  test("a layout that can't be read draws the defaults", async () => {
    context.client = {
      getSidebarLayout: mock(async () => {
        throw new Error("offline");
      }),
    };
    const hook = await renderHook(() => useSidebarLayout("w"), {});
    try {
      await flush();
      expect(hook.result.current.options).toEqual({
        sessionsShowApps: true,
        appsPlacement: "sessions",
        hiddenNavEntries: [],
        settingsMore: null,
        navOrder: null,
        navSetup: null,
      });
    } finally {
      await hook.unmount();
    }
  });

  test("a read that never answers draws the defaults after the wait", async () => {
    context.client = { getSidebarLayout: mock(() => new Promise(() => undefined)) };
    const hook = await renderHook(() => useSidebarLayout("w"), {});
    try {
      expect(hook.result.current.options).toBeNull();
      await actRun(() => new Promise((done) => setTimeout(done, SIDEBAR_OPTIONS_WAIT_MS + 100)));
      expect(hook.result.current.options?.sessionsShowApps).toBe(true);
    } finally {
      await hook.unmount();
    }
  });

  test("without a known person nothing is remembered", async () => {
    const person = context.accessContext.subjectId;
    context.accessContext.subjectId = "";
    try {
      context.client = { getSidebarLayout: mock(async () => appsOff()) };
      const hook = await renderHook(() => useSidebarLayout("w"), {});
      await flush();
      expect(hook.result.current.options?.sessionsShowApps).toBe(false);
      await hook.unmount();
      expect(window.localStorage.length).toBe(0);
    } finally {
      context.accessContext.subjectId = person;
    }
  });
});
