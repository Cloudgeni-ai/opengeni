import { afterEach, describe, expect, test } from "bun:test";
import { observeMarkdownTableLayout } from "../src/components/markdown-table-layout";
import { registerDom } from "./render-hook";

registerDom();

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
  table.getBoundingClientRect = () => new DOMRect(0, 0, preferred, 100);
  return {
    scroller,
    message,
    body,
    wrapper,
    table,
    resize: (value: number) => (preferred = value),
  };
}

afterEach(() => document.body.replaceChildren());

describe("lazy markdown table observer", () => {
  test("expands, shrinks, restores inline table width, and cleans up observation", () => {
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
      cleanup?.();
      expect(disconnected).toBe(true);
      expect(f.wrapper.style.maxWidth).toBe("");
      expect(f.wrapper.style.marginInline).toBe("");
    } finally {
      globalThis.ResizeObserver = original;
    }
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
      cleanup?.();
      expect(f.wrapper.style.width).toBe("");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
