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

  test("an open row copies its whole step: title, then its body", async () => {
    const writes: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void writes.push(text) },
    });
    try {
      const r = await renderComponent(
        <ActivityDisclosure icon={<span>i</span>} title="Repository preparation failed">
          <div>clone exited with 128</div>
        </ActivityDisclosure>,
      );
      await flush();
      const trigger = r.container.querySelector('[role="button"]') as HTMLElement;
      expect(r.container.querySelector("[data-og-copy-step]")).toBeNull();
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const copy = r.container.querySelector("[data-og-copy-step]") as HTMLButtonElement;
      expect(copy.getAttribute("aria-label")).toBe("Copy step");
      await act(async () => {
        copy.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();
      expect(writes).toEqual(["Repository preparation failed\n\nclone exited with 128"]);
      // Copying never closes the row.
      expect(trigger.getAttribute("data-state")).toBe("open");
      expect(copy.getAttribute("aria-label")).toBe("Copied");
      await r.unmount();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  test("a step cut off on its one line opens to its whole note", async () => {
    const proto = HTMLElement.prototype;
    const scrollWidth = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
    const clientWidth = Object.getOwnPropertyDescriptor(proto, "clientWidth");
    Object.defineProperty(proto, "scrollWidth", { configurable: true, get: () => 400 });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 120 });
    try {
      const note =
        "Includes overlapping sandbox startup, custom environment setup, repository preparation, and runtime setup shown below.";
      const r = await renderComponent(
        <ActivityDisclosure
          icon={<span>i</span>}
          title="Runtime/model preparation failed"
          preview={note}
          expandable={false}
        />,
      );
      await flush();
      const trigger = r.container.querySelector('[role="button"]') as HTMLElement;
      expect(trigger).not.toBeNull();
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flush();
      expect(trigger.getAttribute("data-state")).toBe("open");
      expect(r.container.textContent).toContain(note);
      expect(r.container.querySelector("[data-og-copy-step]")).not.toBeNull();
      await r.unmount();
    } finally {
      if (scrollWidth) Object.defineProperty(proto, "scrollWidth", scrollWidth);
      else delete (proto as { scrollWidth?: unknown }).scrollWidth;
      if (clientWidth) Object.defineProperty(proto, "clientWidth", clientWidth);
      else delete (proto as { clientWidth?: unknown }).clientWidth;
    }
  });

  test("a step that fits its line stays a static line", async () => {
    const r = await renderComponent(
      <ActivityDisclosure
        icon={<span>i</span>}
        title="Sandbox ready"
        preview="1.2s"
        expandable={false}
      />,
    );
    await flush();
    expect(r.container.querySelector('[role="button"]')).toBeNull();
    await r.unmount();
  });

  test("selecting the row's text leaves it as it is", async () => {
    const r = await renderComponent(row());
    await flush();
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement;
    const title = trigger.querySelector("span.font-medium") ?? trigger;
    const range = document.createRange();
    range.selectNodeContents(title);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(trigger.getAttribute("data-state")).toBe("closed");
    selection.removeAllRanges();
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(trigger.getAttribute("data-state")).toBe("open");
    await r.unmount();
  });

  test("a step that fits again after being cut off goes back to a static line", async () => {
    const proto = HTMLElement.prototype;
    const scrollWidth = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
    const clientWidth = Object.getOwnPropertyDescriptor(proto, "clientWidth");
    let width = 120;
    Object.defineProperty(proto, "scrollWidth", { configurable: true, get: () => 400 });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => width });
    const RealObserver = globalThis.ResizeObserver;
    const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
    globalThis.ResizeObserver = class {
      private entry: { callback: ResizeObserverCallback; targets: Set<Element> };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        this.entry.targets.clear();
      }
    } as unknown as typeof ResizeObserver;
    try {
      const r = await renderComponent(
        <ActivityDisclosure
          icon={<span>i</span>}
          title="Runtime/model preparation failed"
          preview="Includes overlapping sandbox startup and repository preparation."
          expandable={false}
        />,
      );
      await flush();
      expect(r.container.querySelector('[role="button"]')).not.toBeNull();
      // The window widens: the observer still watches the row's live nodes.
      width = 600;
      const live = observers.filter((observer) =>
        [...observer.targets].some((target) => target.isConnected),
      );
      expect(live.length).toBeGreaterThan(0);
      await act(async () => {
        for (const observer of live) observer.callback([], observer as never);
      });
      expect(r.container.querySelector('[role="button"]')).toBeNull();
      await r.unmount();
    } finally {
      globalThis.ResizeObserver = RealObserver;
      if (scrollWidth) Object.defineProperty(proto, "scrollWidth", scrollWidth);
      else delete (proto as { scrollWidth?: unknown }).scrollWidth;
      if (clientWidth) Object.defineProperty(proto, "clientWidth", clientWidth);
      else delete (proto as { clientWidth?: unknown }).clientWidth;
    }
  });

  test("Copy sits beside the open row's button, not inside it", async () => {
    const r = await renderComponent(
      <ActivityDisclosure icon={<span>i</span>} title="Repository preparation failed">
        <div>clone exited with 128</div>
      </ActivityDisclosure>,
    );
    await flush();
    const trigger = r.container.querySelector('[role="button"]') as HTMLElement;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const copy = r.container.querySelector("[data-og-copy-step]")!;
    expect(trigger.contains(copy)).toBe(false);
    await r.unmount();
  });
});
