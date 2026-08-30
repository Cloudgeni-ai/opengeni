import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { AppCapabilityConfirmation } from "./app-capability-confirmation";

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("App capability confirmation", () => {
  test("is labelled, keyboard reachable, and cannot start before explicit confirmation", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onStart = mock(() => undefined);
    let confirmed = false;
    const render = async () => {
      await act(async () => {
        root.render(
          <AppCapabilityConfirmation
            tools={[
              {
                identity: { serverId: "status", toolName: "read" },
                modelName: "status__read",
                programmaticPath: ["status", "read"],
                title: "Status read",
                description: "Read service health",
                inputSchema: {},
                source: "mcp",
                effect: "read",
                replaySafety: "safe",
                openWorld: false,
                approval: "none",
                supportedSurfaces: ["app"],
                requiredPermissions: ["apps:run"],
              },
            ]}
            confirmed={confirmed}
            busy={false}
            onConfirmedChange={(next) => {
              confirmed = next;
              void render();
            }}
            onStart={onStart}
          />,
        );
      });
    };
    try {
      await render();
      const fieldset = container.querySelector("fieldset");
      const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const button = container.querySelector<HTMLButtonElement>("button");
      expect(fieldset?.querySelector("legend")?.textContent).toBe("Access for this run");
      expect(checkbox?.getAttribute("aria-describedby")).toBeTruthy();
      expect(button?.disabled).toBe(true);

      await act(async () => checkbox?.click());
      expect(button?.disabled).toBe(false);
      await act(async () => {
        fieldset?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
        );
      });
      expect(onStart).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
