import { afterEach, describe, expect, test } from "bun:test";
import type { LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposerModelPicker, type ModelLevel } from "../src/components/model-level-picker";
import { LEVEL_MODELS, LEVELS, levelModel } from "./fixtures/level-models";
import { registerDom } from "./render-hook";

registerDom();

window.matchMedia = ((query: string) =>
  ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  }) as MediaQueryList) as typeof window.matchMedia;

const MODELS = LEVEL_MODELS;

let mounted: { root: Root; container: HTMLElement } | null = null;
afterEach(async () => {
  if (!mounted) return;
  const current = mounted;
  mounted = null;
  await act(async () => current.root.unmount());
  current.container.remove();
});

type Policy = { model: string; effort: ReasoningEffort; latencyMode: LatencyMode };

async function render(initial: Policy, levels: ModelLevel[] | null = LEVELS, models = MODELS) {
  const seen: Policy[] = [];
  function Host() {
    const [policy, setPolicy] = useState(initial);
    const update = (patch: Partial<Policy>) =>
      setPolicy((current) => {
        const next = { ...current, ...patch };
        seen.push(next);
        return next;
      });
    return (
      <ComposerModelPicker
        levels={levels ?? undefined}
        models={models}
        model={policy.model}
        effort={policy.effort}
        latencyMode={policy.latencyMode}
        onModelChange={(next) => update({ model: next })}
        onEffortChange={(next) => update({ effort: next })}
        onLatencyModeChange={(next) => update({ latencyMode: next })}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => root.render(<Host />));
  const slider = () => container.querySelector<HTMLElement>('[role="slider"]');
  const key = async (name: string, repeat = false) =>
    act(async () => {
      slider()!.dispatchEvent(new KeyboardEvent("keydown", { key: name, repeat, bubbles: true }));
    });
  const keyUp = async (name: string) =>
    act(async () => {
      slider()!.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true }));
    });
  return { container, slider, key, keyUp, last: () => seen.at(-1) };
}

describe("ComposerModelPicker", () => {
  test("shows the levels instead of the full picker and names the current one", async () => {
    const view = await render({ model: "codex/everyday", effort: "high", latencyMode: "standard" });
    expect(view.slider()?.getAttribute("aria-valuetext")).toBe("Standard");
    expect(view.slider()?.getAttribute("aria-label")).toBe("Thinking level");
    expect(view.container.textContent).toContain("Thorough");
    expect(view.container.querySelector('[aria-haspopup="dialog"]')).toBeNull();
  });

  test("without levels the host gets the full picker", async () => {
    const view = await render(
      { model: "codex/everyday", effort: "high", latencyMode: "standard" },
      null,
    );
    expect(view.slider()).toBeNull();
    expect(view.container.querySelector('[aria-haspopup="dialog"]')).not.toBeNull();
  });

  test("a level sets its model and effort; Enter steps and wraps", async () => {
    const view = await render({ model: "codex/everyday", effort: "high", latencyMode: "standard" });
    await view.key("Enter");
    expect(view.last()).toEqual({ model: "codex/deep", effort: "high", latencyMode: "standard" });
    expect(view.slider()?.getAttribute("aria-valuetext")).toBe("Thorough");
    expect(view.slider()?.getAttribute("aria-description")).toBe("Hold for Ultrafast");
    // The first landing on a level with Ultrafast says how to turn it on, once.
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe("Hold for Ultrafast");
    await view.key("Enter");
    expect(view.slider()?.getAttribute("aria-valuetext")).toBe("Standard");
  });

  test("Ultrafast takes a held push past the end, never a single step", async () => {
    const view = await render({ model: "codex/deep", effort: "high", latencyMode: "standard" });
    const realNow = performance.now.bind(performance);
    let now = 1_000;
    performance.now = () => now;
    try {
      await view.key("ArrowRight");
      expect(view.last()).toBeUndefined();
      now += 300;
      await view.key("ArrowRight", true);
      expect(view.last()).toBeUndefined();
      await view.keyUp("ArrowRight");
      now += 100;
      await view.key("ArrowRight");
      now += 800;
      await view.key("ArrowRight", true);
    } finally {
      performance.now = realNow;
    }
    expect(view.last()).toEqual({ model: "codex/deep", effort: "high", latencyMode: "ultrafast" });
    expect(view.slider()?.getAttribute("aria-valuetext")).toBe("Thorough, Ultrafast");
    expect(view.container.querySelector('[data-testid="model-level-ultrafast"]')).not.toBeNull();
    // Stepping back turns Ultrafast off and keeps the level.
    await view.key("ArrowLeft");
    expect(view.last()?.latencyMode).toBe("standard");
    expect(view.last()?.model).toBe("codex/deep");
  });

  test("holding the pill charges Ultrafast on any level that allows it; a press steps", async () => {
    const both = LEVELS.map((level) => ({ ...level, ultrafast: true }));
    const models = [levelModel("codex/everyday", "Everyday", true), MODELS[1]!];
    const view = await render(
      { model: "codex/everyday", effort: "high", latencyMode: "standard" },
      both,
      models,
    );
    expect(view.slider()?.getAttribute("aria-description")).toBe("Hold for Ultrafast");
    const press = async (ms: number) => {
      await act(async () => {
        view.slider()!.dispatchEvent(
          new PointerEvent("pointerdown", {
            button: 0,
            clientX: 10,
            pointerId: 1,
            bubbles: true,
          }),
        );
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
      await act(async () => {
        view
          .slider()!
          .dispatchEvent(
            new PointerEvent("pointerup", { button: 0, clientX: 10, pointerId: 1, bubbles: true }),
          );
      });
    };
    // Let go before the charge is full: nothing changes, not even the level.
    await press(400);
    expect(view.last()).toBeUndefined();
    await press(900);
    expect(view.last()).toEqual({
      model: "codex/everyday",
      effort: "high",
      latencyMode: "ultrafast",
    });
    expect(view.slider()?.getAttribute("aria-valuetext")).toBe("Standard, Ultrafast");
    // A quick press turns it off again and keeps the level.
    await press(20);
    expect(view.last()?.latencyMode).toBe("standard");
    expect(view.last()?.model).toBe("codex/everyday");
    await press(20);
    expect(view.last()?.model).toBe("codex/deep");
  });

  test("holding Space charges Ultrafast; a quick Space steps", async () => {
    const view = await render({ model: "codex/everyday", effort: "high", latencyMode: "standard" });
    await view.key(" ");
    await view.keyUp(" ");
    expect(view.last()?.model).toBe("codex/deep");
    const realNow = performance.now.bind(performance);
    let now = 1_000;
    performance.now = () => now;
    try {
      await view.key(" ");
      now += 400;
      await view.key(" ", true);
      expect(view.last()?.latencyMode).toBe("standard");
      now += 400;
      await view.key(" ", true);
      await view.keyUp(" ");
    } finally {
      performance.now = realNow;
    }
    expect(view.last()).toEqual({ model: "codex/deep", effort: "high", latencyMode: "ultrafast" });
  });

  test("a chat on another model shows it, and choosing snaps to a level", async () => {
    const view = await render({ model: "codex/small", effort: "medium", latencyMode: "standard" });
    expect(view.slider()?.getAttribute("aria-valuetext")).toBe(
      "Small · Medium, not one of the levels",
    );
    expect(view.container.textContent).toContain("Small · Medium");
    expect(view.last()).toBeUndefined();
    await view.key("ArrowRight");
    expect(view.last()).toEqual({
      model: "codex/everyday",
      effort: "high",
      latencyMode: "standard",
    });
  });

  test("a level without Ultrafast never offers it", async () => {
    const view = await render(
      { model: "codex/deep", effort: "high", latencyMode: "standard" },
      LEVELS.map((level) => ({ ...level, ultrafast: false })),
    );
    expect(view.slider()?.getAttribute("aria-description")).toBeNull();
  });
});
