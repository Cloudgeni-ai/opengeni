import { hasPermission } from "@opengeni/core";
import type { AttemptToolDefinition } from "@opengeni/codemode";
import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  type FirstPartyMcpToolName,
  type Permission,
  type ToolRef,
} from "@opengeni/contracts";

export const SESSION_TITLE_MODEL_TOOL_NAME = "opengeni__set_session_title";

const SESSION_TITLE_DESCRIPTION =
  "Set this session's display title to a concise 3-7 word topic label. Use a stable noun phrase about the actual task or subject, never a quote/prefix of a prompt, greeting, request boilerplate, URL, identifier, credential, token, or other sensitive value. Call once on a new session, then only when the topic materially changes. Never call it as routine setup after a continuation, resume, or interruption, or merely to reassert the same title. A human-set title cannot be replaced.";

export function shouldRequestMissingSessionTitle(input: {
  title: string | null;
  titleSource: "user" | "agent" | null;
  firstPartyMcpTools: readonly FirstPartyMcpToolName[];
  firstPartyMcpPermissions: readonly Permission[] | null;
}): boolean {
  const title = input.title?.trim() ?? "";
  const needsSemanticTitle =
    input.titleSource !== "user" && (!title || title === AUTOMATIC_SESSION_TITLE_FALLBACK);
  if (!needsSemanticTitle) return false;
  if (!input.firstPartyMcpTools.includes("set_session_title")) return false;
  const permissions = input.firstPartyMcpPermissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS;
  return hasPermission([...permissions], "sessions:control");
}

export function sessionTitleToolPlan(input: {
  tools: readonly ToolRef[];
  selectedFirstPartyMcpTools: readonly FirstPartyMcpToolName[];
  shouldRequestTitle: boolean;
}): {
  promoteTitleTool: boolean;
  remoteFirstPartyMcpTools: FirstPartyMcpToolName[];
  preparationIndependentToolNames: string[];
} {
  const promoteTitleTool =
    input.shouldRequestTitle &&
    input.tools.some((tool) => tool.kind === "mcp" && tool.id === "opengeni");
  return {
    promoteTitleTool,
    remoteFirstPartyMcpTools: promoteTitleTool
      ? input.selectedFirstPartyMcpTools.filter((tool) => tool !== "set_session_title")
      : [...input.selectedFirstPartyMcpTools],
    preparationIndependentToolNames: promoteTitleTool ? [SESSION_TITLE_MODEL_TOOL_NAME] : [],
  };
}

export function createSessionTitleAttemptToolDefinition(input: {
  updateTitle: (title: string) => Promise<{ updated: boolean; title: string | null }>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: "set_session_title" },
    modelName: SESSION_TITLE_MODEL_TOOL_NAME,
    codemodePath: ["opengeni", "set_session_title"],
    title: "Set session title",
    description: SESSION_TITLE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["title"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean", const: true },
        updated: { type: "boolean" },
        title: { type: "string" },
      },
      required: ["ok", "updated", "title"],
      additionalProperties: false,
    },
    annotations: {
      title: "Set session title",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      const title = args.title;
      if (typeof title !== "string") {
        throw new Error("set_session_title requires a title string");
      }
      const result = await input.updateTitle(title);
      const output = {
        ok: true as const,
        updated: result.updated,
        title: result.title ?? title,
      };
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  };
}
