import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserAction,
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

// Native range inputs, and custom sliders that move only with their arrow
// keys: the usual way, reversed, ignoring keys, in tenths, up and down only,
// and right to left sitting at its minimum.
const fixture = `data:text/html,${encodeURIComponent(`<!doctype html><html lang="en-US">
<label>Volume <input type="range" min="0" max="100" step="5" value="50" data-testid="volume"></label>
<label>Opacity <input type="range" min="0" max="1" step="0.1" value="0.3"></label>
<fieldset disabled><label>Locked <input type="range" min="0" max="100" value="10" data-testid="locked"></label></fieldset>
<div role="slider" tabindex="0" aria-label="Level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" data-step="1" data-up="ArrowRight" data-down="ArrowLeft"></div>
<div role="slider" tabindex="0" aria-label="Depth" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" data-step="-1" data-up="ArrowRight" data-down="ArrowLeft"></div>
<div role="slider" tabindex="0" aria-label="Stuck" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div>
<div role="slider" tabindex="0" aria-label="Gain" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0.2" data-step="0.1" data-up="ArrowRight" data-down="ArrowLeft"></div>
<div role="slider" tabindex="0" aria-label="Height" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" data-step="1" data-up="ArrowUp" data-down="ArrowDown"></div>
<div role="slider" tabindex="0" aria-label="Balance" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-step="1" data-up="ArrowLeft" data-down="ArrowRight"></div>
<output aria-label="Changes"></output>
<script>
  const log = document.querySelector("output");
  const volume = document.querySelector("[data-testid=volume]");
  for (const type of ["input", "change"])
    volume.addEventListener(type, () => { log.textContent += type + "=" + volume.value + ";"; });
  const locked = document.querySelector("[data-testid=locked]");
  locked.addEventListener("input", () => { log.textContent += "locked=" + locked.value + ";"; });
  for (const slider of document.querySelectorAll("[data-step]")) {
    const step = Number(slider.dataset.step);
    const min = Number(slider.getAttribute("aria-valuemin"));
    const max = Number(slider.getAttribute("aria-valuemax"));
    slider.addEventListener("keydown", (event) => {
      const now = Number(slider.getAttribute("aria-valuenow"));
      const delta = event.key === slider.dataset.up ? step : event.key === slider.dataset.down ? -step : 0;
      if (!delta) return;
      event.preventDefault();
      slider.setAttribute("aria-valuenow", String(Math.max(min, Math.min(max, now + delta))));
    });
  }
</script>`)}`;

type Node = InteractionSemanticNodeValue;

function nodes(observed: BrowserObservation): Node[] {
  const all: Node[] = [];
  const visit = (item: Node): void => {
    all.push(item);
    for (const child of item.children ?? []) visit(child);
  };
  const semantic = observed.semantic;
  if (semantic?.kind === "snapshot") for (const root of semantic.roots) visit(root);
  return all;
}

function node(observed: BrowserObservation, role: string, name: string): Node {
  const found = nodes(observed).find((item) => item.role === role && item.name === name);
  if (!found) throw new Error(`no ${role} named ${name}`);
  return found;
}

e2e(
  "fill sets native range inputs directly and custom sliders with their arrow keys",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-slider-fill-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
    });
    const dispatch = (observed: BrowserObservation, action: BrowserAction) =>
      driver.dispatch({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: observed.browserSessionId,
        controllerGeneration: observed.target.controllerGeneration,
        targetId: observed.target.id,
        expectedTargetGeneration: observed.target.targetGeneration,
        expectedDocumentGeneration: observed.target.documentGeneration,
        expectedFrameId: observed.frameId,
        actor: { kind: "system", subjectId: "public-slider-fixture" },
        action,
      } satisfies BrowserActionCommand);
    const fresh = (observed: BrowserObservation) => driver.observe(observed.target.id);
    const fill = (observed: BrowserObservation, name: string, value: string) =>
      dispatch(observed, {
        type: "fill",
        locator: { kind: "ref", ref: node(observed, "slider", name).ref },
        value,
      });
    try {
      let observed = await driver.start(fixture);
      expect(node(observed, "slider", "Level").actions).toContain("fill");

      // A native range input takes an allowed value at once, as a drag does.
      await fill(observed, "Volume", "35");
      observed = await fresh(observed);
      expect(node(observed, "slider", "Volume").value).toBe("35");
      expect(nodes(observed).some((item) => item.name === "input=35;change=35;")).toBe(true);

      // A value between its steps is refused with the nearest allowed one.
      await expect(fill(observed, "Volume", "33")).rejects.toMatchObject({
        code: "invalid_action",
        message: expect.stringContaining("nearest value it takes is 35"),
      });

      // A custom slider moves with its arrow keys to the exact value.
      await fill(observed, "Level", "34");
      observed = await fresh(observed);
      expect(node(observed, "slider", "Level").value).toBe("34");

      // Out of range is refused before any key.
      await expect(fill(observed, "Level", "150")).rejects.toMatchObject({
        code: "invalid_action",
        message: expect.stringContaining("from 0 to 100"),
      });

      // A reversed slider is found out by its first press.
      await fill(observed, "Depth", "60");
      observed = await fresh(observed);
      expect(node(observed, "slider", "Depth").value).toBe("60");

      // A slider that ignores its keys fails clearly.
      await expect(fill(observed, "Stuck", "40")).rejects.toMatchObject({
        message: expect.stringContaining("did not move"),
      });

      // A fractional value reads as the page set it, not as a 32-bit float.
      expect(node(observed, "slider", "Opacity").value).toBe("0.3");

      // A range input in a disabled fieldset is refused and left alone.
      await expect(fill(observed, "Locked", "70")).rejects.toMatchObject({
        code: "invalid_action",
        message: expect.stringContaining("disabled"),
      });

      // Steps of a tenth reach their value despite floating-point sums.
      await fill(observed, "Gain", "0.5");
      // A slider that listens only for up and down still moves.
      await fill(observed, "Height", "53");
      // A right-to-left slider at its minimum finds its raising key.
      await fill(observed, "Balance", "4");
      observed = await fresh(observed);
      expect(Number(node(observed, "slider", "Gain").value)).toBeCloseTo(0.5, 9);
      expect(node(observed, "slider", "Height").value).toBe("53");
      expect(node(observed, "slider", "Balance").value).toBe("4");
      expect(node(observed, "slider", "Locked").value).toBe("10");
      expect(nodes(observed).some((item) => item.name?.includes("locked=") === true)).toBe(false);
    } finally {
      await driver.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
