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
  const loaded = { models, error: null };

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

  test("stays unknown until the catalog has loaded, or when it failed", () => {
    const model = "gpt-6-luna";
    expect(sessionModelMissingFromCatalog({ ...loaded, model, error: "Try again." })).toBe(false);
    expect(sessionModelMissingFromCatalog({ ...loaded, model, models: [] })).toBe(false);
  });

  test("leaves connection- and subscription-owned models to the API refusal", () => {
    // An existing session may keep running a retained custom definition the
    // catalog no longer lists, and the edge admits subscription namespaces.
    for (const model of [
      "workspace-gateway/vendor/retired-slug",
      "organization-openrouter/vendor/retired-slug",
      "workspace-anthropic/claude-retired",
      "organization-claude-subscription/claude-retired",
      "workspace-openai-00000000-0000-4000-8000-000000000001/gpt-custom",
      "codex/gpt-legacy",
      "supergrok/grok-legacy",
    ]) {
      expect(sessionModelMissingFromCatalog({ ...loaded, model })).toBe(false);
    }
    // The deployment OpenRouter rail is catalog-owned.
    expect(
      sessionModelMissingFromCatalog({ ...loaded, model: "openrouter/vendor/retired-model:free" }),
    ).toBe(true);
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
        rows,
        defaultSelection: { model: "gpt-6-astra", reasoningEffort: "low", source: "deployment" },
        latencyMode: "standard",
        codexOnly: true,
      })?.model,
    ).toBe("codex/gpt-6-sol");
  });

  test("falls back to another selectable row when the preferred one is filtered out", () => {
    const codexMini = catalogModel({
      id: "codex/gpt-6-mini",
      label: "GPT-6 Mini (Codex)",
      source: "codex",
    });
    const unselectableCodex = catalogModel({
      id: "codex/gpt-6-sol",
      source: "codex",
      availability: { status: "unavailable", selectable: false, reason: null, checkedAt: null },
    });
    const pool = [astra, unselectableCodex, codexMini];
    const replacement = unavailableModelReplacement({
      rows: sortPickerRows(projectPickerRows(pool)),
      defaultSelection: { model: "gpt-6-astra", reasoningEffort: "low", source: "deployment" },
      latencyMode: "standard",
      codexOnly: true,
    });
    expect(replacement?.model).toBe("codex/gpt-6-mini");
    expect(replacement?.reasoningEffort).toBe("low");
  });

  test("returns null when nothing is selectable", () => {
    expect(
      unavailableModelReplacement({
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
