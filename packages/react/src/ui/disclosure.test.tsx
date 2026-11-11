import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

// Register the DOM before React DOM and Radix load, so Radix uses real layout effects.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Disclosure } = await import("./disclosure");

afterAll(() => GlobalRegistrator.unregister());

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const SUMMARY = "New chat each run · Managed sandbox · Workspace learning defaults";
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

describe("Disclosure", () => {
  for (const variant of ["row", "inline"] as const) {
    test(`${variant}: the summary describes the closed row and the content stays mounted`, async () => {
      const change = mock();
      await act(async () =>
        root.render(
          <Disclosure variant={variant} title="Advanced" summary={SUMMARY} onOpenChange={change}>
            <label>
              Where it runs <input defaultValue="Managed sandbox" />
            </label>
          </Disclosure>,
        ),
      );
      const trigger = container.querySelector<HTMLButtonElement>("button")!;
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toBe(
        SUMMARY,
      );
      const content = document.getElementById(trigger.getAttribute("aria-controls")!)!;
      // Kept in the DOM (hidden with CSS) so form fields keep their values while closed.
      expect(content.querySelector("input")).not.toBeNull();
      expect(content.getAttribute("data-state")).toBe("closed");
      expect(content.className).toContain("data-[state=closed]:hidden");

      await act(async () => trigger.click());
      expect(change).toHaveBeenCalledWith(true);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(trigger.hasAttribute("aria-describedby")).toBe(false);
      expect(content.getAttribute("data-state")).toBe("open");
    });
  }

  test("an error inside replaces the summary", async () => {
    await act(async () =>
      root.render(
        <Disclosure
          title="Advanced"
          summary={SUMMARY}
          error="Data notebooks was deleted. Choose where it runs."
        >
          <span />
        </Disclosure>,
      ),
    );
    expect(container.textContent).toContain("Data notebooks was deleted.");
    expect(container.textContent).not.toContain("Managed sandbox");
    // Only the summary is clamped to one or two lines; an error always shows in full.
    const line = document.getElementById(
      container.querySelector("button")!.getAttribute("aria-describedby")!,
    )!;
    expect(line.outerHTML).not.toContain("line-clamp");
  });

  test("a disabled row says why and can't open", async () => {
    await act(async () =>
      root.render(
        <Disclosure
          title="Advanced"
          summary={SUMMARY}
          disabled
          disabledReason="Only Maria Chen, who owns this schedule, can change how it runs."
        >
          <span />
        </Disclosure>,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.disabled).toBe(true);
    expect(
      document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent,
    ).toContain("Only Maria Chen");
  });

  test("sheet: the row opens a titled dialog with the options", async () => {
    await act(async () =>
      root.render(
        <Disclosure
          variant="sheet"
          title="Advanced"
          summary={SUMMARY}
          sheetDescription="Summarize new Sentry errors"
        >
          <p>Where it runs</p>
        </Disclosure>,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(container.textContent).not.toContain("Where it runs");

    await act(async () => trigger.click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Advanced",
    );
    expect(dialog.textContent).toContain("Where it runs");
    expect(dialog.textContent).toContain("Done");
  });
});
