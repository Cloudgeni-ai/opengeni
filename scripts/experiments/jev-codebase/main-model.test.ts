import { test, expect } from "bun:test";
import { mainModelConfig, assertMainModelLedger, assertAstraBaseline } from "./main-model";

test("main model selection is explicit and does not change Terra defaults", () => {
  expect(mainModelConfig().id).toBe("openai/gpt-5.6-terra");
  expect(mainModelConfig("astra").id).toBe("openai/gpt-6-astra");
  expect(mainModelConfig("astra").budget).toEqual({
    baselineAttempts: 648,
    baselineUsd: 1.7286868619999969,
    maxAdditionalAttempts: 60,
    maxAdditionalUsd: 2,
  });
  for (const name of ["astra-fast", "", "other", "openai/gpt-6-astra"])
    expect(() => mainModelConfig(name)).toThrow("unsupported_main_model");
});

test("new model pass cannot run against missing or substituted history", () => {
  expect(() => assertAstraBaseline("")).toThrow("astra_baseline_mismatch");
  expect(() => assertAstraBaseline("x".repeat(929375))).toThrow("astra_baseline_mismatch");
  expect(() => assertMainModelLedger("", "astra")).toThrow("content_baseline_mismatch");
  expect(() => assertMainModelLedger("x".repeat(929375), "astra")).toThrow(
    "content_baseline_mismatch",
  );
});
