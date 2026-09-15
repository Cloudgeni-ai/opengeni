import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { readFileSync } from "node:fs";
import { parse } from "postcss";
import { PreviewLoading } from "../src/components/preview-loading";
import { Markdown } from "../src/components/markdown";
import { registerDom, renderComponent } from "./render-hook";

registerDom();
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

test("compiled light palette overrides dark defaults for root, ancestor and subtree themes", async () => {
  const css = parse(readFileSync(new URL("../styles/compiled.css", import.meta.url), "utf8"));
  const paletteRules: string[] = [];
  css.walkRules((rule) => {
    if (rule.nodes.some((node) => node.type === "decl" && node.prop === "--_og-preview-ink")) {
      paletteRules.push(rule.toString());
    }
  });
  const style = document.createElement("style");
  style.textContent = paletteRules.join("\n");
  document.head.appendChild(style);
  try {
    for (const themeClass of [false, true]) {
      const themeProps = themeClass ? { className: "og-light" } : { "data-og-theme": "light" };
      for (const location of ["root", "ancestor", "subtree"]) {
        const preview = <div className="og-preview-loading" />;
        const r = await renderComponent(
          location === "root" ? (
            <div {...themeProps} className={`og-root ${themeClass ? "og-light" : ""}`}>
              {preview}
            </div>
          ) : location === "ancestor" ? (
            <div {...themeProps}>
              <div className="og-root">{preview}</div>
            </div>
          ) : (
            <div className="og-root">
              <div {...themeProps}>{preview}</div>
            </div>
          ),
        );
        expect(
          getComputedStyle(r.container.querySelector(".og-preview-loading")!)
            .getPropertyValue("--_og-preview-ink")
            .trim(),
        ).toBe("#76629c");
        await r.unmount();
      }
    }
  } finally {
    style.remove();
  }
});

function replace(target: object, key: PropertyKey, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  restores.push(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
}

function environment(
  options: { reduced?: boolean; canvas?: "null" | "throw"; observers?: boolean } = {},
) {
  let paints = 0;
  let observed: IntersectionObserverCallback | undefined;
  let resized: ResizeObserverCallback | undefined;
  let disconnected = 0;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const motion = new EventTarget() as EventTarget & { matches: boolean };
  motion.matches = options.reduced ?? false;
  replace(window, "matchMedia", () => motion);
  replace(document, "hidden", false);
  replace(HTMLCanvasElement.prototype, "clientWidth", 744);
  replace(HTMLCanvasElement.prototype, "clientHeight", 320);
  replace(HTMLCanvasElement.prototype, "getContext", () => {
    if (options.canvas === "throw") throw new Error("Canvas disabled");
    if (options.canvas === "null") return null;
    return {
      setTransform() {},
      clearRect() {
        paints++;
      },
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      arc() {},
      fill() {},
    };
  });
  replace(window, "requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  replace(window, "cancelAnimationFrame", (id: number) => frames.delete(id));
  replace(
    globalThis,
    "IntersectionObserver",
    options.observers === false
      ? undefined
      : class {
          constructor(callback: IntersectionObserverCallback) {
            observed = callback;
          }
          observe() {}
          disconnect() {
            disconnected++;
          }
        },
  );
  replace(
    globalThis,
    "ResizeObserver",
    options.observers === false
      ? undefined
      : class {
          constructor(callback: ResizeObserverCallback) {
            resized = callback;
          }
          observe() {}
          disconnect() {
            disconnected++;
          }
        },
  );
  return {
    frames,
    motion,
    get paints() {
      return paints;
    },
    get disconnected() {
      return disconnected;
    },
    intersect(visible: boolean) {
      observed?.(
        [{ isIntersecting: visible } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    },
    resize() {
      resized?.([], {} as ResizeObserver);
    },
    tick(stamp = 100) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(stamp);
    },
  };
}

test("animation starts only onscreen, pauses hidden/offscreen, resumes once and cleans up", async () => {
  const env = environment();
  const r = await renderComponent(<PreviewLoading />);
  expect(env.frames.size).toBe(0);
  expect(env.paints).toBe(0);
  env.intersect(true);
  expect(env.frames.size).toBe(1);
  env.tick();
  expect(env.frames.size).toBe(1);
  env.intersect(false);
  const pausedPaints = env.paints;
  env.resize();
  expect(env.frames.size).toBe(0);
  expect(env.paints).toBe(pausedPaints);
  env.intersect(true);
  replace(document, "hidden", true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(env.frames.size).toBe(0);
  replace(document, "hidden", false);
  document.dispatchEvent(new Event("visibilitychange"));
  env.resize();
  expect(env.frames.size).toBe(1);
  await r.unmount();
  expect(env.frames.size).toBe(0);
  expect(env.disconnected).toBe(2);
  const finalPaints = env.paints;
  document.dispatchEvent(new Event("visibilitychange"));
  env.motion.dispatchEvent(new Event("change"));
  env.resize();
  env.intersect(true);
  expect(env.paints).toBe(finalPaints);
  expect(env.frames.size).toBe(0);
});

test("reduced motion paints a still grid without ongoing frames, including live preference changes", async () => {
  const env = environment({ reduced: true });
  const r = await renderComponent(<PreviewLoading />);
  env.intersect(true);
  expect(env.paints).toBe(1);
  expect(env.frames.size).toBe(0);
  env.motion.matches = false;
  env.motion.dispatchEvent(new Event("change"));
  expect(env.frames.size).toBe(1);
  env.motion.matches = true;
  env.motion.dispatchEvent(new Event("change"));
  expect(env.frames.size).toBe(0);
  const paints = env.paints;
  env.tick();
  expect(env.paints).toBe(paints);
  env.resize();
  expect(env.paints).toBe(paints + 1);
  expect(env.frames.size).toBe(0);
  await r.unmount();
});

test("unavailable canvas keeps the CSS fallback and steady label with no frames", async () => {
  for (const canvas of ["null", "throw"] as const) {
    const env = environment({ canvas });
    const r = await renderComponent(<PreviewLoading />);
    expect(r.container.textContent).toBe("Preparing preview…");
    expect(r.container.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
    expect(r.container.querySelector("canvas")?.dataset.painted).toBeUndefined();
    expect(env.frames.size).toBe(0);
    await r.unmount();
  }
});

test("missing observers or motion API degrades to a static grid", async () => {
  const env = environment({ observers: false });
  replace(window, "matchMedia", undefined);
  const r = await renderComponent(<PreviewLoading />);
  expect(env.paints).toBe(1);
  expect(env.frames.size).toBe(0);
  window.dispatchEvent(new Event("resize"));
  expect(env.paints).toBe(2);
  await r.unmount();
});

test("stream appends retain the canvas; stopped and completed fences dispose animation", async () => {
  for (const kind of ["html", "site"]) {
    for (const end of ["stopped", "complete"]) {
      const env = environment();
      let executions = 0;
      const render = () => {
        executions++;
        return <div>Complete preview</div>;
      };
      const source = `\`\`\`opengeni-${kind}\nsecret partial source`;
      const r = await renderComponent(
        <Markdown streaming renderInteractiveBlock={render}>
          {source}
        </Markdown>,
      );
      env.intersect(true);
      const canvas = r.container.querySelector("canvas");
      await r.rerender(
        <Markdown streaming renderInteractiveBlock={render}>
          {source + " more"}
        </Markdown>,
      );
      expect(r.container.querySelector("canvas")).toBe(canvas);
      expect(executions).toBe(0);
      expect(r.container.textContent).not.toContain("secret partial source");
      await act(async () => {
        await r.rerender(
          <Markdown streaming={end === "complete"} renderInteractiveBlock={render}>
            {source + (end === "complete" ? "\n```" : "")}
          </Markdown>,
        );
      });
      expect(r.container.querySelector("canvas")).toBeNull();
      expect(env.frames.size).toBe(0);
      expect(r.container.textContent).toContain(
        end === "complete" ? "Complete preview" : "Preview incomplete",
      );
      expect(executions > 0).toBe(end === "complete");
      await r.unmount();
    }
  }
});
