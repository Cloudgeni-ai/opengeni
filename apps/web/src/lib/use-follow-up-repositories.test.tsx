import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  registerDom,
  renderComponent,
  renderHook,
} from "../../../../packages/react/test/render-hook";
import type { AccessContext } from "@opengeni/react/app/types";
import { createElement, StrictMode } from "react";
import { useRepositoryCatalogRefresh } from "@opengeni/react/app/lib/use-follow-up-repositories";
import {
  clearGitHubAccessChanges,
  markGitHubAccessChanged,
} from "@opengeni/react/app/lib/github-access-return";

registerDom();
/** Lets a refresh started by an event finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  mock.restore();
  clearGitHubAccessChanges();
});

function fixture(permissions: AccessContext["workspaceGrants"][number]["permissions"]) {
  return {
    accessContext: {
      mode: "local",
      subjectId: "user:a",
      accountGrants: [],
      defaultAccountId: null,
      defaultWorkspaceId: null,
      workspaceGrants: [
        { workspaceId: "workspace-1", accountId: "account-1", subjectId: "user:a", permissions },
      ],
    } satisfies AccessContext,
    captureWorkspaceInvocation: mock((_workspaceId: string) => ({
      workspaceId: "workspace-1",
      revision: 1,
    })),
    refreshGitHub: mock(
      async (_workspaceId: string, _signal?: AbortSignal, _options?: { sync?: boolean }) => {},
    ),
    refreshPersonalGitHub: mock(async (_workspaceId: string) => {}),
    repoBusy: false,
    personalGitHubBusy: false,
  };
}

describe("repository catalog refresh", () => {
  test("reads on open, throttles rapid reopenings and lets an explicit manager refresh sync", async () => {
    let now = 100_000;
    spyOn(Date, "now").mockImplementation(() => now);
    const context = fixture(["github:use", "github:manage", "connections:read"]);
    const hook = await renderHook(
      () => useRepositoryCatalogRefresh("workspace-1", context),
      undefined,
    );
    await hook.result.current.onOpenRefresh();
    expect(context.refreshGitHub).toHaveBeenLastCalledWith("workspace-1", undefined, {
      sync: false,
      userInitiated: false,
    });
    expect(context.refreshPersonalGitHub).toHaveBeenCalledTimes(1);
    await hook.rerender();
    await hook.result.current.onOpenRefresh();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(1);
    now += 30_000;
    await hook.result.current.onOpenRefresh();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(2);
    await hook.result.current.onRefresh();
    expect(context.refreshGitHub).toHaveBeenLastCalledWith("workspace-1", undefined, {
      sync: true,
      userInitiated: true,
    });
    expect(context.refreshGitHub).toHaveBeenCalledTimes(3);
    await hook.unmount();
  });

  test("does not request ungranted catalogs or sync for non-managers", async () => {
    const context = fixture([]);
    const hook = await renderHook(
      (current: typeof context) => useRepositoryCatalogRefresh("workspace-1", current),
      context,
    );
    expect(hook.result.current.refreshAllowed).toBe(false);
    await hook.result.current.onOpenRefresh();
    await hook.result.current.onRefresh();
    expect(context.refreshGitHub).not.toHaveBeenCalled();
    expect(context.refreshPersonalGitHub).not.toHaveBeenCalled();
    const reader = fixture(["github:use"]);
    await hook.rerender(reader);
    await hook.result.current.onRefresh();
    expect(reader.refreshGitHub).toHaveBeenLastCalledWith("workspace-1", undefined, {
      sync: false,
      userInitiated: true,
    });
    expect(reader.refreshPersonalGitHub).not.toHaveBeenCalled();
    const personal = fixture(["connections:read"]);
    await hook.rerender(personal);
    await hook.result.current.onOpenRefresh();
    expect(personal.refreshGitHub).not.toHaveBeenCalled();
    expect(personal.refreshPersonalGitHub).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });

  test("deduplicates in-flight reads and does not inherit a previous transition's cooldown", async () => {
    let finish!: () => void;
    const context = fixture(["github:use"]);
    context.refreshGitHub.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const hook = await renderHook(
      () => useRepositoryCatalogRefresh("workspace-1", context),
      undefined,
    );
    const first = hook.result.current.onOpenRefresh();
    const second = hook.result.current.onOpenRefresh();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    context.captureWorkspaceInvocation.mockReturnValue({ workspaceId: "workspace-1", revision: 2 });
    await hook.result.current.onOpenRefresh();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(2);
    await hook.unmount();
  });

  test("skips busy catalogs and bounds automatic retry after a failed read", async () => {
    const context = fixture(["github:use"]);
    const hook = await renderHook(
      (current: typeof context) => useRepositoryCatalogRefresh("workspace-1", current),
      { ...context, repoBusy: true },
    );
    await hook.result.current.onOpenRefresh();
    expect(context.refreshGitHub).not.toHaveBeenCalled();
    await hook.rerender(context);
    context.refreshGitHub.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(hook.result.current.onOpenRefresh()).rejects.toThrow("Unavailable");
    await hook.result.current.onOpenRefresh();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(1);
    await hook.result.current.onRefresh();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(2);
    await hook.unmount();
  });

  test("refreshes and syncs whenever the person is back from a GitHub flow, skipping the cooldown", async () => {
    let now = 200_000;
    spyOn(Date, "now").mockImplementation(() => now);
    const context = fixture(["github:use", "github:manage", "connections:read"]);
    const hook = await renderHook(
      () => useRepositoryCatalogRefresh("workspace-1", context),
      undefined,
    );
    await hook.result.current.onOpenRefresh();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(1);
    // Focus without having left for GitHub changes nothing.
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(1);

    hook.result.current.onLeaveForGitHub();
    now += 15_000;
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(2);
    expect(context.refreshGitHub).toHaveBeenLastCalledWith("workspace-1", undefined, {
      sync: true,
      userInitiated: false,
    });
    expect(context.refreshPersonalGitHub).toHaveBeenCalledTimes(2);
    // Alt-tabbing right back is throttled briefly...
    now += 2_000;
    window.dispatchEvent(new Event("focus"));
    await hook.result.current.onOpenRefresh();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(2);
    // ...but a glance back doesn't use up the return: the next one still syncs.
    now += 20_000;
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(3);
    expect(context.refreshGitHub).toHaveBeenLastCalledWith("workspace-1", undefined, {
      sync: true,
      userInitiated: false,
    });
    // Ten minutes on, a focus is an ordinary focus and opening is throttled again.
    now += 10 * 60_000;
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(3);
    await hook.result.current.onOpenRefresh();
    expect(context.refreshGitHub).toHaveBeenLastCalledWith("workspace-1", undefined, {
      sync: false,
      userInitiated: false,
    });
    await hook.unmount();
  });

  test("a hidden tab waits until it is visible again", async () => {
    const context = fixture(["github:use"]);
    const hook = await renderHook(
      () => useRepositoryCatalogRefresh("workspace-1", context),
      undefined,
    );
    markGitHubAccessChanged("workspace-1");
    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(context.refreshGitHub).not.toHaveBeenCalled();
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(context.refreshGitHub).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
      await hook.unmount();
    }
  });

  test("a return while the list is loading keeps the mark for the next one", async () => {
    const context = fixture(["github:use", "github:manage"]);
    const hook = await renderHook(
      (current: typeof context) => useRepositoryCatalogRefresh("workspace-1", current),
      { ...context, repoBusy: true },
    );
    hook.result.current.onLeaveForGitHub();
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(context.refreshGitHub).not.toHaveBeenCalled();
    await hook.rerender(context);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(context.refreshGitHub).toHaveBeenLastCalledWith("workspace-1", undefined, {
      sync: true,
      userInitiated: false,
    });
    await hook.unmount();
  });

  test("a composer mounted after the GitHub settings page refreshes once, also in StrictMode", async () => {
    const context = fixture(["github:use"]);
    markGitHubAccessChanged("workspace-1");
    function Composer() {
      useRepositoryCatalogRefresh("workspace-1", context);
      return null;
    }
    const rendered = await renderComponent(
      createElement(StrictMode, null, createElement(Composer)),
    );
    await settle();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(1);
    // Readers keep catalog reads: no sync without github:manage.
    expect(context.refreshGitHub).toHaveBeenLastCalledWith("workspace-1", undefined, {
      sync: false,
      userInitiated: false,
    });
    await rendered.unmount();
  });
});
