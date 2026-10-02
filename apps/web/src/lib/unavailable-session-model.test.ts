import { describe, expect, test } from "bun:test";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";

import { projectPickerRows, sortPickerRows } from "@opengeni/react";
import {
  scheduledRunErrorText,
  SCHEDULED_RUN_MODEL_UNAVAILABLE_MESSAGE,
} from "./scheduled-run-error";
import {
  sessionModelMissingFromCatalog,
  unavailableModelName,
  unavailableModelReplacement,
} from "./unavailable-session-model";

function catalogModel(
  overrides: Partial<WorkspaceModelCatalogModel> & Pick<WorkspaceModelCatalogModel, "id">,
): WorkspaceModelCatalogModel {
  return {
    label: overrides.id,
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
    source: "opengeni",
    cost: "credits",
    credentialReadiness: { status: "ready", reason: null, basis: "configuration", checkedAt: null },
    policyAllowed: true,
    availability: { status: "available", selectable: true, reason: null, checkedAt: null },
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "medium", "high"],
        defaultEffort: "low",
        required: false,
      },
      functionCalling: { upstream: "supported", runnable: true },
      structuredOutput: { upstream: "supported", runnable: true },
      hostedTools: {
        webSearch: { upstream: "unsupported", runnable: false },
        xSearch: { upstream: "unsupported", runnable: false },
        codeExecution: { upstream: "unsupported", runnable: false },
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      transports: {
        sse: { upstream: "supported", runnable: true },
        responsesWebSocket: { upstream: "unsupported", runnable: false },
        realtimeAudio: { upstream: "unsupported", runnable: false },
      },
      latencyModes: [{ id: "standard", upstream: "supported", runnable: true }],
    },
    billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    ...overrides,
  } as WorkspaceModelCatalogModel;
}

const astra = catalogModel({ id: "gpt-6-astra", label: "GPT-6 Astra" });
const sol = catalogModel({ id: "gpt-6-sol", label: "GPT-6 Sol", aliases: ["sol-latest"] });
const codex = catalogModel({ id: "codex/gpt-6-sol", label: "GPT-6 Sol (Codex)", source: "codex" });
const models = [astra, sol, codex];
const rows = sortPickerRows(projectPickerRows(models));

describe("sessionModelMissingFromCatalog", () => {
  const loaded = { models, loading: false, error: null };

  test("a model the loaded catalog no longer lists is unavailable", () => {
    expect(
      sessionModelMissingFromCatalog({
        ...loaded,
        model: "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
      }),
    ).toBe(true);
    expect(sessionModelMissingFromCatalog({ ...loaded, model: "gpt-6-luna" })).toBe(true);
  });

  test("listed models and aliases are available, even when not ready", () => {
    expect(sessionModelMissingFromCatalog({ ...loaded, model: "gpt-6-astra" })).toBe(false);
    expect(sessionModelMissingFromCatalog({ ...loaded, model: "sol-latest" })).toBe(false);
    const notReady = catalogModel({
      id: "codex/gpt-6-luna",
      source: "codex",
      credentialReadiness: {
        status: "not_ready",
        reason: "missing_credential",
        basis: "connection",
        checkedAt: null,
      },
      availability: {
        status: "unavailable",
        selectable: false,
        reason: "missing_credential",
        checkedAt: null,
      },
    });
    expect(
      sessionModelMissingFromCatalog({
        ...loaded,
        models: [...models, notReady],
        model: "codex/gpt-6-luna",
      }),
    ).toBe(false);
  });

  test("stays unknown while the catalog is loading, failed, or empty", () => {
    const model = "gpt-6-luna";
    expect(sessionModelMissingFromCatalog({ ...loaded, model, loading: true })).toBe(false);
    expect(sessionModelMissingFromCatalog({ ...loaded, model, error: "Try again." })).toBe(false);
    expect(sessionModelMissingFromCatalog({ ...loaded, model, models: [] })).toBe(false);
  });
});

describe("unavailableModelName", () => {
  test("uses the product label for known ids and a readable segment otherwise", () => {
    expect(unavailableModelName("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(unavailableModelName("openrouter/nvidia/nemotron-3-super-120b-a12b:free")).toBe(
      "nemotron-3-super-120b-a12b",
    );
    expect(unavailableModelName("custom-model")).toBe("custom-model");
  });
});

describe("unavailableModelReplacement", () => {
  test("prefers the server-resolved default and keeps a runnable speed", () => {
    expect(
      unavailableModelReplacement({
        models,
        rows,
        defaultSelection: { model: "gpt-6-sol", reasoningEffort: "high", source: "credits" },
        latencyMode: "standard",
        codexOnly: false,
      }),
    ).toEqual({
      model: "gpt-6-sol",
      label: "GPT-6 Sol",
      reasoningEffort: "high",
      latencyMode: null,
    });
  });

  test("resets a speed the replacement cannot run", () => {
    expect(
      unavailableModelReplacement({
        models,
        rows,
        defaultSelection: { model: "gpt-6-astra", reasoningEffort: "low", source: "deployment" },
        latencyMode: "priority",
        codexOnly: false,
      })?.latencyMode,
    ).toBe("standard");
  });

  test("a remote-compaction session is only offered Codex models", () => {
    expect(
      unavailableModelReplacement({
        models,
        rows,
        defaultSelection: { model: "gpt-6-astra", reasoningEffort: "low", source: "deployment" },
        latencyMode: "standard",
        codexOnly: true,
      })?.model,
    ).toBe("codex/gpt-6-sol");
  });

  test("returns null when nothing is selectable", () => {
    expect(
      unavailableModelReplacement({
        models: [],
        rows: [],
        defaultSelection: null,
        latencyMode: "standard",
        codexOnly: false,
      }),
    ).toBeNull();
  });
});

describe("scheduledRunErrorText", () => {
  test("a run refused for its model names the fix", () => {
    for (const error of [
      "scheduled_model_unavailable",
      "model is not available: gpt-6-luna",
      "Turn execution policy model is not present in the configured catalog",
      "Turn execution policy model is retired from new selection",
    ]) {
      expect(scheduledRunErrorText(error)).toBe(SCHEDULED_RUN_MODEL_UNAVAILABLE_MESSAGE);
    }
  });

  test("other run errors pass through", () => {
    expect(scheduledRunErrorText("  Sandbox capacity is unavailable.  ")).toBe(
      "Sandbox capacity is unavailable.",
    );
  });
});
