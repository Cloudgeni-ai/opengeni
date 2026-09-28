import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { SegmentedControl, type SegmentedControlOption } from "./segmented-control";
import { SettingRow } from "./setting-row";
import { TooltipProvider } from "./tooltip";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

type Mode = "automatic" | "review_first" | "off";

const MODES: SegmentedControlOption<Mode>[] = [
  { value: "automatic", label: "Automatic" },
  { value: "review_first", label: "Review first" },
  { value: "off", label: "Off" },
];

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function radios(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

function checkedLabels(container: HTMLElement) {
  return radios(container)
    .filter((radio) => radio.getAttribute("aria-checked") === "true")
    .map((radio) => radio.textContent);
}

describe("SegmentedControl", () => {
  test("is a radio group with exactly one checked option", async () => {
    const view = await render(
      <SegmentedControl aria-label="Knowledge" options={MODES} defaultValue="review_first" />,
    );
    try {
      const group = view.container.querySelector('[role="radiogroup"]');
      expect(group?.getAttribute("aria-label")).toBe("Knowledge");
      expect(radios(view.container)).toHaveLength(3);
      expect(checkedLabels(view.container)).toEqual(["Review first"]);
    } finally {
      await view.unmount();
    }
  });

  test("clicking picks an option; clicking the active one never clears it", async () => {
    const changes: Mode[] = [];
    const view = await render(
      <SegmentedControl
        aria-label="Knowledge"
        options={MODES}
        defaultValue="automatic"
        onValueChange={(value) => changes.push(value)}
      />,
    );
    try {
      const [automatic, , off] = radios(view.container);
      await act(async () => off!.click());
      expect(changes).toEqual(["off"]);
      expect(checkedLabels(view.container)).toEqual(["Off"]);
      await act(async () => off!.click());
      expect(changes).toEqual(["off"]);
      expect(checkedLabels(view.container)).toEqual(["Off"]);
      await act(async () => automatic!.click());
      expect(checkedLabels(view.container)).toEqual(["Automatic"]);
    } finally {
      await view.unmount();
    }
  });

  test("arrow keys move focus without picking", async () => {
    const changes: Mode[] = [];
    const view = await render(
      <SegmentedControl
        aria-label="Knowledge"
        options={MODES}
        defaultValue="automatic"
        onValueChange={(value) => changes.push(value)}
      />,
    );
    try {
      const [automatic, review] = radios(view.container);
      await act(async () => automatic!.focus());
      await act(async () => {
        automatic!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
        // Radix moves roving focus on the next task.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.activeElement).toBe(review!);
      expect(changes).toEqual([]);
      expect(checkedLabels(view.container)).toEqual(["Automatic"]);
    } finally {
      await view.unmount();
    }
  });

  test("an option with a reason stays focusable, is described and can't be picked", async () => {
    const changes: string[] = [];
    const reason = "Acme Robotics hasn't assigned a Codex account to this workspace.";
    const view = await render(
      <SegmentedControl
        aria-label="Use subscriptions from"
        options={[
          { value: "organization", label: "Organization", disabled: true, disabledReason: reason },
          { value: "workspace", label: "This workspace" },
        ]}
        defaultValue="workspace"
        onValueChange={(value) => changes.push(value)}
      />,
    );
    try {
      const [organization] = radios(view.container);
      expect(organization!.disabled).toBe(false);
      expect(organization!.getAttribute("aria-disabled")).toBe("true");
      const describedBy = organization!.getAttribute("aria-describedby");
      expect(describedBy ? document.getElementById(describedBy)?.textContent : null).toBe(reason);
      await act(async () => organization!.click());
      expect(changes).toEqual([]);
      expect(checkedLabels(view.container)).toEqual(["This workspace"]);
    } finally {
      await view.unmount();
    }
  });

  test("counts, icon-only names and setting row wiring", async () => {
    const view = await render(
      <SettingRow
        label="Show people"
        description="Filter the list."
        controlWidth="auto"
        control={
          <SegmentedControl
            options={[
              { value: "all", label: "All", count: 6 },
              { value: "grid", label: "Grid", icon: <svg />, iconOnly: true },
            ]}
          />
        }
      />,
    );
    try {
      const group = view.container.querySelector('[role="radiogroup"]')!;
      const labelledBy = group.getAttribute("aria-labelledby");
      expect(labelledBy ? document.getElementById(labelledBy)?.textContent : null).toBe(
        "Show people",
      );
      const describedBy = group.getAttribute("aria-describedby");
      expect(describedBy ? document.getElementById(describedBy)?.textContent : null).toBe(
        "Filter the list.",
      );
      const [all, grid] = radios(view.container);
      expect(all!.textContent).toBe("All6");
      expect(grid!.getAttribute("aria-label")).toBe("Grid");
      // Uncontrolled default is the first enabled option.
      expect(all!.getAttribute("aria-checked")).toBe("true");
    } finally {
      await view.unmount();
    }
  });
});
