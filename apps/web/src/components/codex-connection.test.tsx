import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

function setClipboard(writeText: (value: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => false,
  });
}

async function renderPanel() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CodexDeviceCodePanel
        userCode="ABCD-1234"
        verificationUri="https://auth.openai.com/codex/device"
      />,
    );
  });
  return { container, root };
}

describe("CodexDeviceCodePanel", () => {
  test("copies the exact device code and confirms the action", async () => {
    const copies: string[] = [];
    setClipboard(async (value) => {
      copies.push(value);
    });
    const { container, root } = await renderPanel();

    try {
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

  test("clears prior success feedback when a later copy fails", async () => {
    let shouldFail = false;
    setClipboard(async () => {
      if (shouldFail) throw new Error("clipboard denied");
    });
    const { container, root } = await renderPanel();

    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click();
        await Promise.resolve();
      });
      expect(container.querySelector('button[aria-label="Code copied"]')).not.toBeNull();

      shouldFail = true;
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Code copied"]')!.click();
        await Promise.resolve();
      });

      expect(container.querySelector('button[aria-label="Code copied"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Copy code"]')?.textContent).toContain(
        "Copy code",
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("ignores an older copy completion after a newer attempt fails", async () => {
    let resolveFirst!: () => void;
    let calls = 0;
    setClipboard(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.reject(new Error("clipboard denied"));
    });
    const { container, root } = await renderPanel();

    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click();
        await Promise.resolve();
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click();
        await Promise.resolve();
      });
      expect(container.querySelector('button[aria-label="Code copied"]')).toBeNull();

      await act(async () => {
        resolveFirst();
        await Promise.resolve();
      });

      expect(calls).toBe(2);
      expect(container.querySelector('button[aria-label="Code copied"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
