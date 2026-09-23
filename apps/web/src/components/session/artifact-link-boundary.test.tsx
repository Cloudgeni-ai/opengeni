import { afterAll, beforeAll, expect, test, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactLinkBoundary } from "./artifact-link-boundary";

beforeAll(() => {
  GlobalRegistrator.register({
    url: "https://console.example",
    settings: {
      navigation: { disableMainFrameNavigation: true, disableChildPageNavigation: true },
    },
  });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

test("routes plain and keyboard clicks while preserving modified clicks and downloads", async () => {
  const workspace = "11111111-1111-4111-8111-111111111111";
  const id = "22222222-2222-4222-8222-222222222222";
  const onOpen = mock(() => true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ArtifactLinkBoundary workspaceId={workspace} onOpen={onOpen}>
          <a href={`/workspaces/${workspace}/artifacts/${id}`} target="_blank">
            <strong>Site</strong>
          </a>
        </ArtifactLinkBoundary>,
      ),
    );
    const label = container.querySelector("strong")!;
    for (const options of [{}, { detail: 0 }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...options });
      await act(async () => {
        label.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenLastCalledWith({ id, editable: false });
    for (const options of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...options });
      label.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    container.querySelector("a")!.setAttribute("download", "");
    label.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
