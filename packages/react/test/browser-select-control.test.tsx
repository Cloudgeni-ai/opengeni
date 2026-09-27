import { expect, test } from "bun:test";
import type {
  BrowserAction,
  BrowserObservation,
  BrowserActionReceipt,
} from "@opengeni/sdk/interaction";
import { BrowserSelectControl } from "../src/components/browser-select-control";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";
registerDom();

function observation(multiple = false): BrowserObservation {
  return {
    observationId: "snapshot-1",
    focusedRef: "select-1",
    semantic: {
      kind: "snapshot",
      nodeCount: 1,
      roots: [
        {
          ref: "select-1",
          role: "combobox",
          name: "Priority",
          states: ["focused"],
          actions: ["select"],
          native: {
            platform: "dom",
            data: {
              kind: "native-select",
              multiple,
              disabled: false,
              options: [
                { value: "low", label: "Low", selected: true, disabled: false },
                { value: "high", label: "High", selected: false, disabled: false },
                { value: "blocked", label: "Blocked", selected: false, disabled: true },
                { value: "collision", label: "Collision", selected: false, disabled: false },
                { value: "other", label: "collision", selected: false, disabled: false },
              ],
            },
          },
        },
      ],
    },
  } as BrowserObservation;
}
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;

test("reads only on demand and dispatches the selected value with the exact observed authority", async () => {
  const seen = observation();
  let reads = 0;
  const calls: { action: BrowserAction; seen: BrowserObservation }[] = [];
  const rendered = await renderComponent(
    <BrowserSelectControl
      observe={async () => {
        reads++;
        return seen;
      }}
      act={async (action, snapshot) => {
        calls.push({ action, seen: snapshot });
        return { state: "completed" } as BrowserActionReceipt;
      }}
    />,
  );
  try {
    expect(reads).toBe(0);
    await actRun(() => button(rendered.container, "Choose option").click());
    await flush();
    expect(reads).toBe(1);
    expect(button(rendered.container, "Blocked").disabled).toBe(true);
    expect(button(rendered.container, "Collision (ambiguous value)").disabled).toBe(true);
    await actRun(() => button(rendered.container, "High").click());
    await flush();
    expect(calls).toEqual([
      {
        action: { type: "select", locator: { kind: "ref", ref: "select-1" }, values: ["high"] },
        seen,
      },
    ]);
    expect(rendered.container.querySelector("section")).toBeNull();
  } finally {
    await rendered.unmount();
  }
});

test("uncertain selection is not replayed and requires another explicit read", async () => {
  let attempts = 0;
  const rendered = await renderComponent(
    <BrowserSelectControl
      observe={async () => observation()}
      act={async () => {
        attempts++;
        throw new Error("The browser page changed");
      }}
    />,
  );
  try {
    await actRun(() => button(rendered.container, "Choose option").click());
    await flush();
    await actRun(() => button(rendered.container, "High").click());
    await flush();
    expect(attempts).toBe(1);
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toBe(
      "The browser page changed",
    );
    expect(button(rendered.container, "High")).toBeUndefined();
  } finally {
    await rendered.unmount();
  }
});

test("multiple selection preserves existing choices until the human applies", async () => {
  const calls: BrowserAction[] = [];
  const rendered = await renderComponent(
    <BrowserSelectControl
      observe={async () => observation(true)}
      act={async (action) => {
        calls.push(action);
        return { state: "completed" } as BrowserActionReceipt;
      }}
    />,
  );
  try {
    await actRun(() => button(rendered.container, "Choose option").click());
    await flush();
    const checks = rendered.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checks[0]?.checked).toBe(true);
    expect(checks[2]?.disabled).toBe(true);
    await actRun(() => checks[1]!.click());
    expect(calls).toHaveLength(0);
    await actRun(() => button(rendered.container, "Apply selection").click());
    await flush();
    expect(calls).toEqual([
      { type: "select", locator: { kind: "ref", ref: "select-1" }, values: ["low", "high"] },
    ]);
  } finally {
    await rendered.unmount();
  }
});
