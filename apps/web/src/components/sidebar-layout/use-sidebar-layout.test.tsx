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

const { useSidebarLayout, resetSidebarLayoutCache } = await import("./use-sidebar-layout");

registerDom();
afterEach(() => {
  resetSidebarLayoutCache();
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
