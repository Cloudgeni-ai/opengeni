import { describe, expect, test } from "bun:test";
import { applyComposerTextareaHeight } from "../src/components/composer";
import { registerDom } from "./render-hook";

registerDom();

/** Records every `style.height` write; the element keeps its real declaration underneath. */
function trackHeightWrites(el: HTMLTextAreaElement): string[] {
  const writes: string[] = [];
  const style = el.style;
  const recording = new Proxy(style, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "height") writes.push(String(value));
      return Reflect.set(target, property, value, target);
    },
  });
  Object.defineProperty(el, "style", { configurable: true, get: () => recording });
  return writes;
}

describe("applyComposerTextareaHeight", () => {
  test("grows from overflow without writing height auto or 0", () => {
    const el = document.createElement("textarea");
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 40 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 96 });
    Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => 40 });
    el.style.height = "40px";
    const writes = trackHeightWrites(el);

    applyComposerTextareaHeight(el, 220);
    expect(writes).not.toContain("auto");
    expect(writes).not.toContain("0px");
    expect(writes).toEqual(["96px"]);
  });

  test("steady fit does not rewrite height", () => {
    const el = document.createElement("textarea");
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 40 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 40 });
    Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => 40 });
    el.style.height = "40px";
    const writes = trackHeightWrites(el);

    applyComposerTextareaHeight(el, 220, () => 40);
    expect(writes).toEqual([]);
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

  test("shrink writes only the final height — never auto or 0", () => {
    const el = document.createElement("textarea");
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => 200 });
    el.style.height = "200px";
    const writes = trackHeightWrites(el);

    applyComposerTextareaHeight(el, 220, () => 48);
    expect(writes).toEqual(["48px"]);
    expect(writes).not.toContain("auto");
    expect(writes).not.toContain("0px");
  });
});
