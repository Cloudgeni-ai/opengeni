import { describe, expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { DEFAULT_OPENROUTER_MODEL_ID } from "@opengeni/config";
import { resolveWorkspaceModelSelection } from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import {
  LIST_MODELS_TOOL_NAME,
  createListModelsAttemptToolDefinition,
  renderListModels,
} from "../src/activities/agent-turn/list-models";

describe("list_models", () => {
  test("renders the current model and selectable picker order with cost and optional notes", () => {
    const settings = testSettings({
      openrouterApiKey: "openrouter-test-key",
      modelCostPolicyJson: JSON.stringify({
        [DEFAULT_OPENROUTER_MODEL_ID]: "free",
        "gpt-5.6-luna": "credits",
      }),
      modelNotesJson: JSON.stringify({
        [DEFAULT_OPENROUTER_MODEL_ID]: "Good for bounded tool-driven work.",
      }),
    });
    const selections = resolveWorkspaceModelSelection({
      settings,
      policy: {
        allowedProviders: null,
        allowedModels: ["gpt-5.6-luna", DEFAULT_OPENROUTER_MODEL_ID],
      },
      codexSubscriptionActive: false,
    });

    expect(
      renderListModels({
        currentModelId: "gpt-5.6-sol",
        selections: [...selections].reverse(),
        modelNotes: JSON.parse(settings.modelNotesJson),
      }),
    ).toBe(
      [
        "Current: gpt-5.6-sol",
        "- gpt-5.6-luna | GPT-5.6 Luna | credits",
        `- ${DEFAULT_OPENROUTER_MODEL_ID} | Nemotron 3 Super 120B | free | Good for bounded tool-driven work.`,
      ].join("\n"),
    );
  });

  test("reports an empty selectable set without inventing model metadata", () => {
    const selections = resolveWorkspaceModelSelection({
      settings: testSettings(),
      policy: { allowedProviders: null, allowedModels: [] },
      codexSubscriptionActive: false,
    });
    expect(
      renderListModels({
        currentModelId: "gpt-5.6-sol",
        selections,
        modelNotes: {},
      }),
    ).toBe("Current: gpt-5.6-sol\nNo models are available in this workspace.");
  });

  test("keeps every rendered field on one unambiguous line", () => {
    const selection = resolveWorkspaceModelSelection({
      settings: testSettings(),
      policy: { allowedProviders: null, allowedModels: ["gpt-5.6-luna"] },
      codexSubscriptionActive: false,
    }).find((candidate) => candidate.model.id === "gpt-5.6-luna");
    expect(selection).toBeDefined();
    const unsafeId = "bad|model\nnext";
    expect(
      renderListModels({
        currentModelId: "current\nmodel",
        selections: [
          {
            ...selection!,
            model: { ...selection!.model, id: unsafeId, label: "Bad|label\nnext" },
          },
        ],
        modelNotes: { [unsafeId]: "Bad|note\nnext" },
      }),
    ).toBe("Current: current model\n- bad model next | Bad label next | credits | Bad note next");
  });

  test("uses an empty strict schema and rejects extra arguments", async () => {
    const definition = createListModelsAttemptToolDefinition({
      currentModelId: null,
      load: async () => ({ selections: [], modelNotes: {} }),
    });
    expect(definition.modelName).toBe("list_models");
    expect(definition.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(definition.outputSchema).toBeUndefined();
    await expect((definition.execute as any)({ extra: true }, {})).rejects.toThrow(
      "list_models accepts no arguments",
    );
    const environment = createAttemptToolEnvironment({
      scope: {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 1,
      },
      generation: 1,
      definitions: [definition],
    });
    const output = await environment.callModel({
      modelName: LIST_MODELS_TOOL_NAME,
      arguments: {},
      subjectId: "agent:test",
    });
    expect(output).toEqual({
      isError: false,
      content: [{ type: "text", text: "No models are available in this workspace." }],
    });
  });

  test("keeps the tool JSON schema stable when deployment notes change", () => {
    const withoutNotes = createListModelsAttemptToolDefinition({
      currentModelId: "gpt-5.6-sol",
      load: async () => ({ selections: [], modelNotes: {} }),
    });
    const withNotes = createListModelsAttemptToolDefinition({
      currentModelId: "gpt-5.6-sol",
      load: async () => ({
        selections: [],
        modelNotes: { "gpt-5.6-sol": "Changed deployment guidance." },
      }),
    });
    expect(withNotes.inputSchema).toEqual(withoutNotes.inputSchema);
  });
});
