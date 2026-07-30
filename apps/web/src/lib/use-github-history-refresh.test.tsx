import { afterEach, describe, expect, mock, test } from "bun:test";
import { actRun, registerDom, renderHook } from "../../../../packages/react/test/render-hook";
import { useGitHubHistoryRefresh } from "./use-github-history-refresh";

registerDom();
afterEach(() => document.body.replaceChildren());

function pageShow(persisted: boolean): Event {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

describe("useGitHubHistoryRefresh", () => {
  test("refreshes GitHub state when browser history restores a workspace page", async () => {
    const refreshGitHub = mock(async () => {});
    const hook = await renderHook(
      ({ workspaceId }: { workspaceId: string }) =>
        useGitHubHistoryRefresh(workspaceId, true, refreshGitHub),
      { workspaceId: "workspace-1" },
    );

    await actRun(() => window.dispatchEvent(pageShow(true)));

    expect(refreshGitHub).toHaveBeenCalledTimes(1);
    expect(refreshGitHub).toHaveBeenCalledWith("workspace-1");
    await hook.unmount();
  });

  test("ignores ordinary page loads and disabled workspace shells", async () => {
    const refreshGitHub = mock(async () => {});
    const hook = await renderHook(
      () => useGitHubHistoryRefresh("workspace-1", false, refreshGitHub),
      undefined,
    );

    await actRun(() => window.dispatchEvent(pageShow(false)));
    await actRun(() => window.dispatchEvent(pageShow(true)));

    expect(refreshGitHub).not.toHaveBeenCalled();
    await hook.unmount();
  });
});
