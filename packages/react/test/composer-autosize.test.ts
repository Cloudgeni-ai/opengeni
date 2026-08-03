import { describe, expect, test } from "bun:test";
import { applyComposerTextareaHeight } from "../src/components/composer";
import { registerDom } from "./render-hook";

registerDom();

describe("applyComposerTextareaHeight", () => {
  test("grows from overflow without writing height 0", () => {
    const el = document.createElement("textarea");
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 40 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 96 });
    Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => 40 });
    el.style.height = "40px";

    const writes: string[] = [];
    const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "height");
    Object.defineProperty(el.style, "height", {
      configurable: true,
      get() {
        return desc?.get?.call(this) ?? "";
      },
      set(value: string) {
        writes.push(value);
        desc?.set?.call(this, value);
      },
    });

    applyComposerTextareaHeight(el, 220);
    expect(writes).not.toContain("0px");
    expect(writes.at(-1)).toBe("96px");
  });

  test("restores prior height when auto measure matches", () => {
    const el = document.createElement("textarea");
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 40 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 40 });
    Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => 40 });
    el.style.height = "40px";

    applyComposerTextareaHeight(el, 220);
    expect(el.style.height).toBe("40px");
  });

  test("caps at maxPx on grow", () => {
    const el = document.createElement("textarea");
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 40 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => 40 });

    applyComposerTextareaHeight(el, 220);
    expect(el.style.height).toBe("220px");
  });
});
