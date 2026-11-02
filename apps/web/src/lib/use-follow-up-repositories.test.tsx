import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { registerDom, renderHook } from "../../../../packages/react/test/render-hook";
import type { AccessContext } from "@opengeni/react/app/types";
import { useRepositoryCatalogRefresh } from "@opengeni/react/app/lib/use-follow-up-repositories";

registerDom();
afterEach(() => mock.restore());

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

  test("refreshes and syncs once the person is back from a GitHub flow, skipping the cooldown", async () => {
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
    await Promise.resolve();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(1);

    hook.result.current.onLeaveForGitHub();
    now += 5_000;
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(2);
    expect(context.refreshGitHub).toHaveBeenLastCalledWith("workspace-1", undefined, {
      sync: true,
      userInitiated: false,
    });
    expect(context.refreshPersonalGitHub).toHaveBeenCalledTimes(2);
    // One refresh per return: the next focus and opening the menu are throttled again.
    window.dispatchEvent(new Event("focus"));
    await hook.result.current.onOpenRefresh();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(2);
    await hook.unmount();
  });

  test("a composer mounted after the GitHub settings page refreshes at once", async () => {
    const context = fixture(["github:use"]);
    const first = await renderHook(
      () => useRepositoryCatalogRefresh("workspace-1", context),
      undefined,
    );
    first.result.current.onLeaveForGitHub();
    await first.unmount();
    expect(context.refreshGitHub).not.toHaveBeenCalled();
    const second = await renderHook(
      () => useRepositoryCatalogRefresh("workspace-1", context),
      undefined,
    );
    await Promise.resolve();
    expect(context.refreshGitHub).toHaveBeenCalledTimes(1);
    // Readers keep catalog reads: no sync without github:manage.
    expect(context.refreshGitHub).toHaveBeenLastCalledWith("workspace-1", undefined, {
      sync: false,
      userInitiated: false,
    });
    await second.unmount();
  });
});
