import { afterEach, describe, expect, test } from "bun:test";
import { observeMarkdownTableLayout } from "../src/components/markdown-table-layout";
import { Markdown } from "../src/components/markdown";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();
const tableRect = HTMLTableElement.prototype.getBoundingClientRect;

function fixture() {
  const scroller = document.createElement("div");
  scroller.setAttribute("data-og-timeline-scroller", "");
  scroller.style.paddingInline = "24px";
  const message = document.createElement("div");
  message.setAttribute("data-og-wide-table-message", "");
  const body = document.createElement("div");
  body.className = "og-markdown-body";
  const wrapper = document.createElement("div");
  const table = document.createElement("table");
  wrapper.append(table);
  body.append(wrapper);
  message.append(body);
  scroller.append(message);
  document.body.append(scroller);
  for (const element of [body, message]) element.style.overflowX = "visible";
  scroller.style.paddingLeft = "24px";
  scroller.style.paddingRight = "24px";
  Object.defineProperty(scroller, "clientWidth", { value: 1440 });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 1440, 800);
  body.getBoundingClientRect = () => new DOMRect(336, 0, 768, 100);
  let preferred = 1100;
  HTMLTableElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, preferred, 100);
  return {
    scroller,
    message,
    body,
    wrapper,
    table,
    resize: (value: number) => (preferred = value),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  HTMLTableElement.prototype.getBoundingClientRect = tableRect;
});

describe("lazy markdown table observer", () => {
  test("measures without changing the live table geometry even when width is cached", () => {
    const f = fixture();
    f.table.style.width = "100%";
    const liveWidths: string[] = [];
    const rect = f.table.getBoundingClientRect;
    f.table.getBoundingClientRect = () => {
      liveWidths.push(f.table.style.width);
      return rect();
    };
    const layout = observeMarkdownTableLayout(f.wrapper, f.table);
    layout?.measure();
    layout?.disconnect();
    expect(liveWidths).not.toContain("max-content");
    expect(f.table.style.width).toBe("100%");
  });

  test("keeps one observer across markdown updates and disconnects on unmount", async () => {
    const original = globalThis.ResizeObserver;
    const observers: Array<{ observed: Element[]; disconnected: boolean }> = [];
    globalThis.ResizeObserver = class {
      observed: Element[] = [];
      disconnected = false;
      constructor() {
        observers.push(this);
      }
      observe(element: Element) {
        this.observed.push(element);
      }
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
    };
    const table = "| Source | Scope |\n| --- | --- |\n| Example | Analytics |";
    const view = (text: string) => (
      <div data-og-timeline-scroller="" style={{ padding: "24px" }}>
        <div data-og-wide-table-message="" style={{ overflowX: "visible" }}>
          <Markdown>{text}</Markdown>
        </div>
      </div>
    );
    let rendered: Awaited<ReturnType<typeof renderComponent>> | undefined;
    try {
      rendered = await renderComponent(view(table));
      await flush();
      const tableObservers = () =>
        observers.filter((o) => o.observed.some((e) => e.tagName === "TABLE"));
      expect(tableObservers()).toHaveLength(1);
      for (const text of [
        table + "\n\nFollowing prose",
        table + "\n\nFollowing prose continues",
        table.replace("Analytics", "A longer scope"),
      ]) {
        await rendered.rerender(view(text));
        await flush();
        expect(tableObservers()).toHaveLength(1);
        expect(tableObservers()[0]!.disconnected).toBe(false);
      }
      await rendered.unmount();
      rendered = undefined;
      expect(tableObservers()[0]!.disconnected).toBe(true);
    } finally {
      await rendered?.unmount();
      globalThis.ResizeObserver = original;
    }
  });

  test("expands, shrinks, preserves inline table width, and cleans up observation", () => {
    const original = globalThis.ResizeObserver;
    let notify = () => {};
    let disconnected = false;
    const observed: Element[] = [];
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        notify = () => callback([], this);
      }
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {
        disconnected = true;
      }
    };
    try {
      const f = fixture();
      f.table.style.width = "100%";
      const cleanup = observeMarkdownTableLayout(f.wrapper, f.table);
      expect(f.wrapper.style.width).toBe("1100px");
      expect(f.table.style.width).toBe("100%");
      expect(observed).toEqual([f.scroller, f.body, f.table]);
      f.resize(1900);
      notify();
      expect(f.wrapper.style.width).toBe("1392px");
      f.resize(400);
      notify();
      expect(f.wrapper.style.width).toBe("768px");
      f.message.style.overflowX = "hidden";
      notify();
      expect(f.wrapper.style.width).toBe("");
      cleanup?.disconnect();
      expect(disconnected).toBe(true);
      expect(f.wrapper.style.maxWidth).toBe("");
      expect(f.wrapper.style.marginInline).toBe("");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  test("keeps measurement copies inert, ID-free, out of flow and removes them on failure", () => {
    const f = fixture();
    f.table.id = "live-table";
    f.table.innerHTML =
      '<tbody><tr><td id="live-cell"><a href="#live-cell" onclick="void 0">A link</a></td></tr></tbody>';
    let probe: HTMLElement | undefined;
    HTMLTableElement.prototype.getBoundingClientRect = function () {
      probe = this.parentElement!;
      expect(probe.isConnected).toBe(true);
      expect(probe.inert).toBe(true);
      expect(probe.getAttribute("aria-hidden")).toBe("true");
      expect(probe.style.position).toBe("absolute");
      expect(probe.style.width).toBe("0px");
      expect(probe.style.height).toBe("0px");
      expect(probe.style.contain).toBe("layout size paint");
      expect(this.id).toBe("");
      expect(this.querySelector("[id]")).toBeNull();
      expect(this.querySelector("[onclick]")).toBeNull();
      throw new Error("Synthetic measurement failure");
    };
    expect(() => observeMarkdownTableLayout(f.wrapper, f.table)).toThrow(
      "Synthetic measurement failure",
    );
    expect(probe?.isConnected).toBe(false);
    expect(f.wrapper.querySelectorAll("table")).toHaveLength(1);
    expect(f.table.id).toBe("live-table");
    expect(f.table.querySelector("td")!.id).toBe("live-cell");
    expect(f.table.querySelector("a")!.getAttribute("onclick")).toBe("void 0");
    expect(f.wrapper.style.width).toBe("");
  });

  test("does not initialize copied custom elements or embedded frames", () => {
    let initialized = 0;
    if (!customElements.get("measurement-widget")) {
      customElements.define(
        "measurement-widget",
        class extends HTMLElement {
          constructor() {
            super();
            initialized++;
          }
        },
      );
    }
    const f = fixture();
    f.table.innerHTML =
      "<tbody><tr><td><measurement-widget></measurement-widget><iframe></iframe><video></video></td></tr></tbody>";
    const before = initialized;
    for (const element of f.table.querySelectorAll("measurement-widget,iframe,video")) {
      element.getBoundingClientRect = () => new DOMRect(0, 0, 240, 80);
    }
    let measured = false;
    HTMLTableElement.prototype.getBoundingClientRect = function () {
      measured = true;
      expect(this.querySelector("measurement-widget,iframe,video")).toBeNull();
      expect(this.querySelectorAll('span[style*="240px"]')).toHaveLength(3);
      return new DOMRect(0, 0, 1100, 100);
    };
    const layout = observeMarkdownTableLayout(f.wrapper, f.table);
    expect(measured).toBe(true);
    expect(initialized).toBe(before);
    expect(f.table.querySelectorAll("measurement-widget,iframe,video")).toHaveLength(3);
    layout?.disconnect();
  });

  test("keeps nested and standalone tables unchanged", () => {
    const f = fixture();
    const quote = document.createElement("blockquote");
    f.body.append(quote);
    quote.append(f.wrapper);
    expect(observeMarkdownTableLayout(f.wrapper, f.table)).toBeUndefined();
    expect(f.wrapper.style.width).toBe("");
    f.body.append(f.wrapper);
    f.message.removeAttribute("data-og-wide-table-message");
    expect(observeMarkdownTableLayout(f.wrapper, f.table)).toBeUndefined();
  });

  test("still measures and cleans up without ResizeObserver", () => {
    const original = globalThis.ResizeObserver;
    Reflect.deleteProperty(globalThis, "ResizeObserver");
    try {
      const f = fixture();
      const cleanup = observeMarkdownTableLayout(f.wrapper, f.table);
      expect(f.wrapper.style.width).toBe("1100px");
      f.resize(1900);
      cleanup?.measure();
      expect(f.wrapper.style.width).toBe("1392px");
      f.resize(400);
      cleanup?.measure();
      expect(f.wrapper.style.width).toBe("768px");
      cleanup?.disconnect();
      expect(f.wrapper.style.width).toBe("");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
