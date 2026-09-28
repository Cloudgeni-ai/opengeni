import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DestructiveConfirmPanel, confirmTextMatches } from "./destructive-confirm";

/** Sets a value the way a keystroke would and runs React's change handler. */
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
    const key = Object.keys(input).find((each) => each.startsWith("__reactProps$"));
    const props = key
      ? (
          input as unknown as Record<
            string,
            { onChange?: (event: { target: HTMLInputElement }) => void }
          >
        )[key]
      : undefined;
    props?.onChange?.({ target: input });
    await Promise.resolve();
  });
}

describe("confirmTextMatches", () => {
  test("matches the exact name, ignoring surrounding spaces", () => {
    expect(confirmTextMatches("Design preview", "Design preview")).toBe(true);
    expect(confirmTextMatches("  Design preview ", "Design preview")).toBe(true);
    expect(confirmTextMatches("design preview", "Design preview")).toBe(false);
    expect(confirmTextMatches("Design prev", "Design preview")).toBe(false);
    expect(confirmTextMatches("", "")).toBe(false);
  });
});

describe("DestructiveConfirmPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeAll(() => {
    GlobalRegistrator.register();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  afterAll(() => GlobalRegistrator.unregister());

  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((each) => each.textContent === label);

  test("type to confirm starts empty and enables the primary only on an exact match", async () => {
    await act(async () =>
      root.render(
        <DestructiveConfirmPanel
          variant="type-to-confirm"
          title="Delete Design preview?"
          consequences={["This can't be undone."]}
          confirmText="Design preview"
          confirmPlaceholder="Workspace name"
          confirmLabel="Delete workspace"
        />,
      ),
    );
    const input = container.querySelector("input")!;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Workspace name");
    expect(button("Delete workspace")!.disabled).toBe(true);

    await typeInto(input, "Design previe");
    expect(button("Delete workspace")!.disabled).toBe(true);
    await typeInto(input, "Design preview");
    expect(button("Delete workspace")!.disabled).toBe(false);
  });

  test("blocked lists what uses it with links and offers no destructive button", async () => {
    const close = mock();
    await act(async () =>
      root.render(
        <DestructiveConfirmPanel
          variant="blocked"
          title="AWS production is in use"
          description="Remove it from this schedule first. Then you can delete it."
          dependencies={[
            {
              id: "sched-aws-cost",
              kind: "schedule",
              kindLabel: "Schedule",
              name: "Check AWS cost anomalies",
              detail: "Every weekday at 08:00 · Oslo",
              href: "/schedules?schedule=sched-aws-cost",
            },
          ]}
          confirmLabel="Delete variable set"
          onClose={close}
        />,
      ),
    );
    expect(button("Delete variable set")).toBeUndefined();
    expect([...container.querySelectorAll("button")].map((each) => each.textContent)).toEqual([
      "Close",
    ]);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/schedules?schedule=sched-aws-cost");
    expect(link.textContent).toContain("Check AWS cost anomalies");
    expect(link.textContent).toContain("Schedule · Every weekday at 08:00 · Oslo");
    await act(async () => button("Close")!.click());
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("a dependency link opens in the app when the caller routes it", async () => {
    const open = mock();
    await act(async () =>
      root.render(
        <DestructiveConfirmPanel
          variant="blocked"
          title="AWS production is in use"
          dependencies={[
            {
              id: "sched-aws-cost",
              kind: "schedule",
              kindLabel: "Schedule",
              name: "Check AWS cost anomalies",
              href: "/schedules?schedule=sched-aws-cost",
            },
          ]}
          onOpenDependency={open}
        />,
      ),
    );
    const link = container.querySelector("a")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => link.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({ href: "/schedules?schedule=sched-aws-cost" });
    // A modified click keeps the browser default (new tab).
    const newTab = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    });
    await act(async () => link.dispatchEvent(newTab));
    expect(newTab.defaultPrevented).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  test("consequences render as a list and the primary is destructive", async () => {
    await act(async () =>
      root.render(
        <DestructiveConfirmPanel
          title="Delete Staging database?"
          consequences={["Its 3 variables are deleted.", "This can't be undone."]}
          confirmLabel="Delete variable set"
        />,
      ),
    );
    expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Its 3 variables are deleted.",
      "This can't be undone.",
    ]);
    expect(button("Delete variable set")!.getAttribute("data-variant")).toBe("destructive");
    expect(button("Cancel")!.hasAttribute("data-autofocus")).toBe(true);
  });
});
