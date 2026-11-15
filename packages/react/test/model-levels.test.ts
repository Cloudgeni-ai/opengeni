import { describe, expect, test } from "bun:test";
import { createOpenGeniText } from "../src/messages/runtime";
import { modelLevelChoice, modelLevelsView } from "../src/model-levels";
import { LEVEL_MODELS, LEVELS, levelModel } from "./fixtures/level-models";

const t = createOpenGeniText();

const models = LEVEL_MODELS;
const levels = LEVELS;

const base = { levels, models, latencyMode: "standard" as const };

describe("modelLevelsView", () => {
  test("finds the level by model and effort", () => {
    const view = modelLevelsView(t, { ...base, model: "codex/deep", effort: "high" })!;
    expect(view.levels.map((state) => state.level.id)).toEqual(["standard", "thorough"]);
    expect(view.index).toBe(1);
    expect(view.levels.map((state) => state.ultrafastAvailable)).toEqual([false, true]);
    expect(view.ultrafast).toBe(false);
    expect(view.ultrafastCost).toBe("8× usage");
  });

  test("a chat on another model or effort is outside the levels and keeps its own name", () => {
    const other = modelLevelsView(t, { ...base, model: "codex/small", effort: "medium" })!;
    expect(other.index).toBe(-1);
    expect(other.customLabel).toBe("Small · Medium");
    const effort = modelLevelsView(t, { ...base, model: "codex/everyday", effort: "low" })!;
    expect(effort.index).toBe(-1);
    expect(effort.customLabel).toBe("Everyday · Low");
  });

  test("Ultrafast needs both the host's permission and a model that can run it", () => {
    const noHost = modelLevelsView(t, {
      ...base,
      levels: levels.map((level) => ({ ...level, ultrafast: false })),
      model: "codex/deep",
      effort: "high",
      latencyMode: "ultrafast",
    })!;
    expect(noHost.levels.some((state) => state.ultrafastAvailable)).toBe(false);
    expect(noHost.ultrafast).toBe(false);
    const noModel = modelLevelsView(t, {
      ...base,
      levels: [{ ...levels[0]!, ultrafast: true }],
      model: "codex/everyday",
      effort: "high",
    })!;
    expect(noModel.levels[0]!.ultrafastAvailable).toBe(false);
    const on = modelLevelsView(t, {
      ...base,
      model: "codex/deep",
      effort: "high",
      latencyMode: "ultrafast",
    })!;
    expect(on.ultrafast).toBe(true);
  });

  test("any number of levels can offer Ultrafast, each with its own cost", () => {
    const view = modelLevelsView(t, {
      ...base,
      models: [levelModel("codex/everyday", "Everyday", true), LEVEL_MODELS[1]!],
      levels: levels.map((level) => ({ ...level, ultrafast: true })),
      model: "codex/everyday",
      effort: "high",
      latencyMode: "ultrafast",
    })!;
    expect(view.levels.map((state) => state.ultrafastAvailable)).toEqual([true, true]);
    expect(view.index).toBe(0);
    expect(view.ultrafast).toBe(true);
    expect(view.ultrafastCost).toBe("8× usage");
    expect(modelLevelChoice(view, 0, true)?.latencyMode).toBe("ultrafast");
  });

  test("levels the workspace cannot run are left out; none left means the full picker", () => {
    const view = modelLevelsView(t, {
      ...base,
      models: [models[0]!],
      model: "codex/everyday",
      effort: "high",
    })!;
    expect(view.levels.map((state) => state.level.id)).toEqual(["standard"]);
    expect(modelLevelsView(t, { ...base, models: [], model: "x", effort: "high" })).toBeNull();
  });
});

describe("modelLevelChoice", () => {
  test("a level sets model and effort, and Ultrafast only where offered", () => {
    const view = modelLevelsView(t, { ...base, model: "codex/small", effort: "medium" })!;
    expect(modelLevelChoice(view, 0, true)).toEqual({
      model: "codex/everyday",
      effort: "high",
      latencyMode: "standard",
    });
    expect(modelLevelChoice(view, 1, true)).toEqual({
      model: "codex/deep",
      effort: "high",
      latencyMode: "ultrafast",
    });
    expect(modelLevelChoice(view, 5, false)).toBeNull();
  });
});
