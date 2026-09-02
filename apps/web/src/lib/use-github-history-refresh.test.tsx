import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import { actRun, registerDom, renderHook } from "../../../../packages/react/test/render-hook";
import { useGitHubHistoryRefresh } from "./use-github-history-refresh";

registerDom();
afterEach(() => {
  jest.useRealTimers();
  document.body.replaceChildren();
});

function pageShow(persisted: boolean): Event {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

describe("useGitHubHistoryRefresh", () => {
  test("refreshes GitHub state when browser history restores a workspace page", async () => {
    jest.useFakeTimers();
    const refreshGitHub = mock(async () => {});
    const hook = await renderHook(
      ({ workspaceId }: { workspaceId: string }) =>
        useGitHubHistoryRefresh(workspaceId, true, refreshGitHub),
      { workspaceId: "workspace-1" },
    );

    await actRun(() => window.dispatchEvent(pageShow(true)));
    await actRun(() => jest.advanceTimersByTime(2_000));

    expect(refreshGitHub).toHaveBeenCalledTimes(1);
    expect(refreshGitHub).toHaveBeenCalledWith("workspace-1");
    await hook.unmount();
  });

  test("ignores ordinary page loads and disabled workspace shells", async () => {
    jest.useFakeTimers();
    const refreshGitHub = mock(async () => {});
    const hook = await renderHook(
      () => useGitHubHistoryRefresh("workspace-1", false, refreshGitHub),
      undefined,
    );

    await actRun(() => window.dispatchEvent(pageShow(false)));
    await actRun(() => window.dispatchEvent(pageShow(true)));
    await actRun(() => jest.advanceTimersByTime(2_000));

    expect(refreshGitHub).not.toHaveBeenCalled();
    await hook.unmount();
  });

  test("debounces focus, visibility, and history restoration into one passive refresh", async () => {
    jest.useFakeTimers();
    const refreshGitHub = mock(async () => {});
    const hook = await renderHook(
      () => useGitHubHistoryRefresh("workspace-1", true, refreshGitHub),
      undefined,
    );

    await actRun(() => window.dispatchEvent(new Event("focus")));
    await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
    await actRun(() => window.dispatchEvent(pageShow(true)));
    await actRun(() => jest.advanceTimersByTime(1_999));
    expect(refreshGitHub).not.toHaveBeenCalled();
    await actRun(() => jest.advanceTimersByTime(1));
    expect(refreshGitHub).toHaveBeenCalledTimes(1);
    expect(refreshGitHub).toHaveBeenCalledWith("workspace-1");
    await hook.unmount();
  });
});
