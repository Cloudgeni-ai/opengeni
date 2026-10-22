import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { SettingRow } from "./setting-row";
import { Switch } from "./switch";
import { TooltipProvider } from "./tooltip";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
  return {
    container,
    rerender: (next: ReactNode) =>
      act(async () => root.render(<TooltipProvider>{next}</TooltipProvider>)),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function control(container: HTMLElement) {
  const element = container.querySelector<HTMLButtonElement>('[role="switch"]');
  if (!element) throw new Error("switch not rendered");
  return element;
}

describe("Switch", () => {
  test("is a labelled switch that reports the next value", async () => {
    const changes: boolean[] = [];
    const view = await render(
      <Switch
        aria-label="Voice input"
        checked={false}
        onCheckedChange={(next) => changes.push(next)}
      />,
    );
    try {
      const element = control(view.container);
      expect(element.getAttribute("aria-checked")).toBe("false");
      expect(element.getAttribute("aria-label")).toBe("Voice input");
      await act(async () => element.click());
      expect(changes).toEqual([true]);
    } finally {
      await view.unmount();
    }
  });

  test("uncontrolled switches keep their own state", async () => {
    const view = await render(<Switch aria-label="Codex Apps" />);
    try {
      const element = control(view.container);
      await act(async () => element.click());
      expect(element.getAttribute("aria-checked")).toBe("true");
      await act(async () => element.click());
      expect(element.getAttribute("aria-checked")).toBe("false");
    } finally {
      await view.unmount();
    }
  });

  test("while saving it stays focusable, reports busy and ignores clicks", async () => {
    const changes: boolean[] = [];
    const view = await render(
      <Switch
        aria-label="Voice input"
        checked
        pending
        onCheckedChange={(next) => changes.push(next)}
      />,
    );
    try {
      const element = control(view.container);
      expect(element.disabled).toBe(false);
      expect(element.getAttribute("aria-busy")).toBe("true");
      element.focus();
      await act(async () => element.click());
      expect(changes).toEqual([]);
      expect(element.getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(element);
      expect(view.container.querySelector("svg")).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("a disabled reason keeps it focusable and describes why", async () => {
    const changes: boolean[] = [];
    const reason = "Video models are paid through AI Gateway.";
    const view = await render(
      <Switch
        aria-label="Video generation"
        disabled
        disabledReason={reason}
        onCheckedChange={(next) => changes.push(next)}
      />,
    );
    try {
      const element = control(view.container);
      expect(element.disabled).toBe(false);
      expect(element.getAttribute("aria-disabled")).toBe("true");
      await act(async () => element.click());
      expect(changes).toEqual([]);
      expect(element.getAttribute("aria-checked")).toBe("false");
      const describedBy = element.getAttribute("aria-describedby")?.split(" ") ?? [];
      const texts = describedBy.map((id) => document.getElementById(id)?.textContent);
      expect(texts).toContain(reason);
    } finally {
      await view.unmount();
    }
  });

  test("without a reason it is natively disabled", async () => {
    const view = await render(<Switch aria-label="Voice input" disabled />);
    try {
      expect(control(view.container).disabled).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  test("state text shows the current state and never becomes the name", async () => {
    const view = await render(
      <SettingRow label="Use for new work" control={<Switch showStateText defaultChecked />} />,
    );
    try {
      const element = control(view.container);
      const words = view.container.querySelector('[data-slot="switch-with-state"] [aria-hidden]');
      expect(words?.querySelector(".invisible")?.textContent).toBe("Off");
      const labelId = element.getAttribute("aria-labelledby");
      expect(labelId ? document.getElementById(labelId)?.textContent : null).toBe(
        "Use for new work",
      );
    } finally {
      await view.unmount();
    }
  });
});
