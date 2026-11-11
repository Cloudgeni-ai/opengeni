// The desktop app's Update button: hidden until the app finds a version, one
// click to install, and progress while it finishes downloading.
import { describe, expect, test } from "bun:test";
import type { DesktopBridge, DesktopUpdateState } from "@opengeni/sdk/desktop-bridge";

import { DesktopUpdateButton } from "../src/app/components/desktop/app-update";
import { TooltipProvider } from "../src/ui/tooltip";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function fakeBridge(initial: DesktopUpdateState) {
  let state = initial;
  const listeners = new Set<(next: DesktopUpdateState) => void>();
  let installs = 0;
  const bridge = {
    productName: "Opengeni",
    capabilities: ["updates"],
    updates: {
      state: async () => state,
      install: async () => {
        installs += 1;
      },
      onChange: (listener: (next: DesktopUpdateState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as DesktopBridge;
  return {
    bridge,
    installs: () => installs,
    push(next: DesktopUpdateState) {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

async function render(bridge: DesktopBridge | null, collapsed = false) {
  const rendered = await renderComponent(
    <TooltipProvider>
      <DesktopUpdateButton collapsed={collapsed} bridge={bridge} />
    </TooltipProvider>,
  );
  await flush();
  return rendered;
}

describe("desktop Update button", () => {
  test("stays hidden on the web and while there is nothing to install", async () => {
    const web = await render(null);
    expect(web.container.querySelector("button")).toBeNull();
    await web.unmount();

    const desktop = fakeBridge({ kind: "none" });
    const idle = await render(desktop.bridge);
    expect(idle.container.querySelector("button")).toBeNull();
    await idle.unmount();
  });

  test("shows as soon as an update is found, before it finishes downloading", async () => {
    const desktop = fakeBridge({
      kind: "downloading",
      version: "0.2.0",
      percent: 20,
      restartWhenReady: false,
    });
    const rendered = await render(desktop.bridge);
    const button = rendered.container.querySelector<HTMLButtonElement>("[data-desktop-update]");
    expect(button?.textContent).toBe("Update available0.2.0");

    await actRun(() => button!.click());
    expect(desktop.installs()).toBe(1);
    expect(button?.textContent).toBe("Updating… 20%0.2.0");
    expect(button?.getAttribute("aria-busy")).toBe("true");

    await actRun(() =>
      desktop.push({ kind: "downloading", version: "0.2.0", percent: 65, restartWhenReady: true }),
    );
    expect(button?.textContent).toBe("Updating… 65%0.2.0");
    // A busy button ignores more clicks.
    await actRun(() => button!.click());
    expect(desktop.installs()).toBe(1);

    await actRun(() => desktop.push({ kind: "ready", version: "0.2.0", restartWhenReady: true }));
    expect(button?.textContent).toBe("Restarting…0.2.0");
    await rendered.unmount();
  });

  test("a collapsed rail shows the icon with an accessible name", async () => {
    const desktop = fakeBridge({ kind: "ready", version: "0.2.0", restartWhenReady: false });
    const rendered = await render(desktop.bridge, true);
    const button = rendered.container.querySelector("[data-desktop-update]");
    expect(button?.getAttribute("aria-label")).toBe("Update available, 0.2.0");
    expect(button?.textContent).toBe("");
    await rendered.unmount();
  });
});
