import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { CodexDeviceCodePanel } from "./codex-connection";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("CodexDeviceCodePanel", () => {
  test("copies the exact device code and confirms the action", async () => {
    const copies: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copies.push(value);
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <CodexDeviceCodePanel
            userCode="ABCD-1234"
            verificationUri="https://auth.openai.com/codex/device"
          />,
        );
      });

      expect(container.querySelector("[data-codex-device-code]")?.textContent).toBe("ABCD-1234");
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');
      expect(button?.type).toBe("button");

      await act(async () => {
        button!.click();
        await Promise.resolve();
      });

      expect(copies).toEqual(["ABCD-1234"]);
      expect(container.querySelector('button[aria-label="Code copied"]')?.textContent).toContain(
        "Copied",
      );
      const authLink = container.querySelector<HTMLAnchorElement>("a");
      expect(authLink?.href).toBe("https://auth.openai.com/codex/device");
      expect(authLink?.target).toBe("_blank");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
