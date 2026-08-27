import type { AttemptToolDefinition } from "@opengeni/codemode";
import type { WorkspaceModelSelection } from "@opengeni/core";

export const LIST_MODELS_TOOL_NAME = "list_models";

export const LIST_MODELS_TOOL_DESCRIPTION =
  "List the models this workspace can select right now, in picker order, with deployment-defined cost and optional guidance. This does not switch the current session model; use an ID with session_create or the human model picker.";

function safeLineField(value: string): string {
  return value
    .replace(/[\r\n|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function renderListModels(input: {
  currentModelId: string | null;
  selections: readonly WorkspaceModelSelection[];
  modelNotes: Readonly<Record<string, string>>;
}): string {
  const lines: string[] = [];
  if (input.currentModelId) {
    lines.push(`Current: ${input.currentModelId}`);
  }

  const selectable = input.selections.filter((entry) => entry.availability.selectable);
  if (selectable.length === 0) {
    lines.push("No models are available in this workspace.");
    return lines.join("\n");
  }

  for (const { model } of selectable) {
    const fields = [model.id, safeLineField(model.label), model.cost];
    const note = input.modelNotes[model.id];
    if (note) fields.push(note);
    lines.push(`- ${fields.join(" | ")}`);
  }
  return lines.join("\n");
}

export function createListModelsAttemptToolDefinition(input: {
  currentModelId: string | null;
  load: () => Promise<{
    selections: readonly WorkspaceModelSelection[];
    modelNotes: Readonly<Record<string, string>>;
  }>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: LIST_MODELS_TOOL_NAME },
    modelName: LIST_MODELS_TOOL_NAME,
    codemodePath: ["opengeni", LIST_MODELS_TOOL_NAME],
    title: "List selectable models",
    description: LIST_MODELS_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: { type: "string" },
    annotations: {
      title: "List selectable models",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      if (Object.keys(args).length !== 0) {
        throw new Error("list_models accepts no arguments");
      }
      const catalog = await input.load();
      return {
        isError: false,
        content: [
          {
            type: "text",
            text: renderListModels({
              currentModelId: input.currentModelId,
              selections: catalog.selections,
              modelNotes: catalog.modelNotes,
            }),
          },
        ],
      };
    },
  };
}
