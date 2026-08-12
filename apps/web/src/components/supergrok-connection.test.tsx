import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { SuperGrokDeviceCodePanel } from "./supergrok-connection";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

describe("SuperGrok device login", () => {
  test("renders the exact xAI code without adding a consent prompt", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SuperGrokDeviceCodePanel userCode="XAI-1234" verificationUri="https://auth.x.ai/device" />,
      );
    });
    expect(container.querySelector("[data-supergrok-device-code]")?.textContent).toBe("XAI-1234");
    expect(container.querySelector<HTMLAnchorElement>("a")?.href).toBe("https://auth.x.ai/device");
    expect(container.textContent?.toLowerCase()).not.toContain("consent");
    await act(async () => root.unmount());
  });
});
