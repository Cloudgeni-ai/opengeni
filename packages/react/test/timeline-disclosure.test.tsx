/* ----------------------------------------------------------------------------
   ActivityDisclosure accessibility + interaction.

   The disclosure row is a Collapsible.Trigger rendered `asChild` onto a <div>
   (so the interactive screenshot thumbnail can nest as valid DOM). Radix does
   not synthesize button semantics for a non-button child, so the row supplies
   role="button", a tab stop, and Enter/Space activation itself. These tests
   pin that down: the row is a focusable button to AT, and the keyboard toggles
   it — not mouse-only.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { registerDom, renderComponent, flush } from "./render-hook";
import { ActivityDisclosure } from "../src/timeline/shared";

registerDom();

function row() {
  return (
    <ActivityDisclosure icon={<span>i</span>} title="ran a command">
      <div data-testid="body">body</div>
    </ActivityDisclosure>
  );
}

describe("ActivityDisclosure", () => {
  test("the trigger is an accessible, focusable button", async () => {
    const r = await renderComponent(row());
    await flush();
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("tabindex")).toBe("0");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    await r.unmount();
  });

  test("Enter and Space toggle the row open and closed", async () => {
    const r = await renderComponent(row());
    await flush();
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement;

    function press(key: string) {
      return act(async () => {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    }

    expect(trigger.getAttribute("data-state")).toBe("closed");
    await press("Enter");
    expect(trigger.getAttribute("data-state")).toBe("open");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await press(" ");
    expect(trigger.getAttribute("data-state")).toBe("closed");
    await r.unmount();
  });

  test("a click toggles the row (mouse parity with the keyboard)", async () => {
    const r = await renderComponent(row());
    await flush();
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(trigger.getAttribute("data-state")).toBe("open");
    await r.unmount();
  });

  test("a non-expandable row is a static line with no button affordance", async () => {
    const r = await renderComponent(
      <ActivityDisclosure icon={<span>i</span>} title="static" expandable={false} />,
    );
    await flush();
    expect(r.container.querySelector('[role="button"]')).toBeNull();
    await r.unmount();
  });
});
