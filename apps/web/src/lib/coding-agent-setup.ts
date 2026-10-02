import {
  DEVELOPER_PLUGIN,
  DEVELOPER_PLUGIN_INSTALL,
  MCP_SERVER_INSTALL,
} from "./coding-agent-install";

/**
 * Coding agents and Opengeni, two ways:
 *
 * - Building a product: the Opengeni Developer plugin, skills only
 *   (`opengeni-setup`, `opengeni-client`), for Claude Code, Codex and Cursor;
 *   other agents copy the two skills into `.agents/skills`. Nothing here needs
 *   MCP sign-in.
 * - Handing work to Opengeni from a terminal: the workspace MCP server
 *   (`/v1/workspaces/:id/mcp`), which signs in with MCP OAuth, so it is offered
 *   only where the server turned that on (`clientConfig.mcpOAuthEnabled`).
 *
 * The install strings live in `coding-agent-install.ts`.
 */

/** The public guide for the Opengeni Developer plugin. */
export const DEVELOPER_PLUGIN_GUIDE_URL = DEVELOPER_PLUGIN.docsUrl;
/** The public guide for having a coding agent put Opengeni in a product. */
export const EMBED_WITH_CODING_AGENT_URL = "https://docs.opengeni.ai/embed-with-a-coding-agent";
/** The managed service; the skills target it unless told otherwise. */
export const MANAGED_API_ORIGIN = "https://app.opengeni.ai";

export const API_KEY_ENV_VAR = "OPENGENI_API_KEY";

export type CodingAgentId = "claude" | "codex" | "cursor" | "vscode" | "other";

export type CodingAgentSetup = Readonly<{
  /** Coding agents can sign in to the workspace MCP server here. */
  oauth: boolean;
  /** The API origin agents and apps talk to. */
  apiOrigin: string;
  workspaceId: string;
  mcpUrl: string;
}>;

export type CodingAgentBlock = Readonly<{
  /** What it is: "Run in your terminal", "~/.cursor/mcp.json". */
  label: string;
  code: string;
}>;

export type CodingAgentGuide = Readonly<{
  agent: CodingAgentId;
  label: string;
  blocks: readonly CodingAgentBlock[];
  /** One or two short sentences under the blocks. */
  note: string;
}>;

/** The origin the browser talks to the API on: the configured API base, else this page. */
export function apiOriginFor(apiBaseUrl: string, pageOrigin: string): string {
  const base = apiBaseUrl.trim();
  if (!base) return pageOrigin;
  try {
    const url = new URL(base, pageOrigin);
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return pageOrigin;
  }
}

export function workspaceMcpUrl(apiOrigin: string, workspaceId: string): string {
  return `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/mcp`;
}

export function codingAgentSetup(input: {
  mcpOAuthEnabled: boolean;
  apiOrigin: string;
  workspaceId: string;
}): CodingAgentSetup {
  return {
    oauth: input.mcpOAuthEnabled,
    apiOrigin: input.apiOrigin,
    workspaceId: input.workspaceId,
    mcpUrl: workspaceMcpUrl(input.apiOrigin, input.workspaceId),
  };
}

const SKILLS_LABEL = "Add the two skills (run in your project)";

/**
 * Building a product: the Opengeni Developer plugin (skills only) for each
 * agent, or the two skills for agents without plugins.
 */
export function developerPluginGuides({
  mcpUrl = null,
}: {
  /**
   * The workspace MCP server, where coding agents can sign in to it
   * (`mcpOAuthEnabled`): Claude Code also gets the line that adds it, at user
   * scope so it works in every project.
   */
  mcpUrl?: string | null;
} = {}): CodingAgentGuide[] {
  const skills = DEVELOPER_PLUGIN_INSTALL.skillsCopy.join("\n");
  return [
    {
      agent: "claude",
      label: "Claude Code",
      blocks: [
        { label: "Run in your terminal", code: DEVELOPER_PLUGIN_INSTALL.claude.join("\n") },
        ...(mcpUrl
          ? [
              {
                label: "Optional: hand work to Opengeni too",
                code: MCP_SERVER_INSTALL.claude(mcpUrl).join("\n"),
              },
            ]
          : []),
      ],
      note: mcpUrl ? "Then run /mcp in Claude Code to sign in." : "",
    },
    {
      agent: "codex",
      label: "Codex",
      blocks: [{ label: "Run in your terminal", code: DEVELOPER_PLUGIN_INSTALL.codex.join("\n") }],
      note: "",
    },
    {
      agent: "cursor",
      label: "Cursor",
      blocks: [
        { label: "Import this repository", code: DEVELOPER_PLUGIN_INSTALL.cursorRepository },
      ],
      note: `In Cursor, open Customize, choose From GitHub Repository, import it, then install ${DEVELOPER_PLUGIN.displayName}.`,
    },
    {
      agent: "vscode",
      label: "VS Code",
      blocks: [{ label: SKILLS_LABEL, code: skills }],
      note: "GitHub Copilot's agent mode reads skills from .agents/skills.",
    },
    {
      agent: "other",
      label: "Other",
      blocks: [{ label: SKILLS_LABEL, code: skills }],
      note: "Most coding agents read .agents/skills. For one that doesn't, point its instructions file (AGENTS.md, for example) at the two SKILL.md files.",
    },
  ];
}

/**
 * Handing work to Opengeni from a terminal: the workspace MCP server per
 * agent. Only where coding agents can sign in (`setup.oauth`).
 */
export function mcpServerGuides(setup: CodingAgentSetup): CodingAgentGuide[] {
  const url = setup.mcpUrl;
  return [
    {
      agent: "claude",
      label: "Claude Code",
      blocks: [{ label: "Run in your terminal", code: MCP_SERVER_INSTALL.claude(url).join("\n") }],
      note: "Then run /mcp in Claude Code, choose opengeni and sign in.",
    },
    {
      agent: "codex",
      label: "Codex",
      blocks: [{ label: "Run in your terminal", code: MCP_SERVER_INSTALL.codex(url).join("\n") }],
      note: "Codex opens the Opengeni sign-in page.",
    },
    {
      agent: "cursor",
      label: "Cursor",
      blocks: [{ label: "Add to ~/.cursor/mcp.json", code: MCP_SERVER_INSTALL.cursor(url) }],
      note: "Cursor asks you to sign in when it first connects.",
    },
    {
      agent: "vscode",
      label: "VS Code",
      blocks: [{ label: "Run in your terminal", code: MCP_SERVER_INSTALL.vscode(url).join("\n") }],
      note: "GitHub Copilot's agent mode opens the sign-in in your browser the first time.",
    },
    {
      agent: "other",
      label: "Other",
      blocks: [{ label: "Workspace MCP server", code: url }],
      note: "Works with any MCP client that supports remote servers and OAuth. No API key needed.",
    },
  ];
}

export type BuildTarget = Readonly<{
  apiOrigin: string;
  organizationId: string;
  workspaceId: string;
}>;

/**
 * What to paste into the coding agent: build a small app on the Opengeni
 * Developer plugin's skills, with this organization's IDs. The key is
 * already made here, so setup only has to use it.
 */
export function buildWithOpengeniPrompt(target: BuildTarget): string {
  const baseUrl =
    target.apiOrigin === MANAGED_API_ORIGIN ? "" : ` (OPENGENI_API_BASE_URL=${target.apiOrigin})`;
  return `Use the ${DEVELOPER_PLUGIN.skills.setup} and ${DEVELOPER_PLUGIN.skills.client} skills to create a small local web app with an Opengeni agent chat. Use the existing workspace ${target.workspaceId} in organization ${target.organizationId}${baseUrl}. I'll paste the API key into .env as ${API_KEY_ENV_VAR}.`;
}

/** Sessions a product created (an API key, or a user it acts as), not a person here. */
export function isAppCreatedSession(session: {
  createdBy?: { subjectId?: string | null } | null;
}): boolean {
  const subject = session.createdBy?.subjectId ?? "";
  return subject.startsWith("api_key:") || subject.startsWith("external_user:");
}

/**
 * The one block "Copy setup for my coding agent" copies: the Opengeni
 * Developer plugin install for Claude Code, the prompt, and where the key
 * goes. The key is only ever in this copied text (and the page's memory),
 * never stored.
 */
export function codingAgentSetupBlock({
  prompt,
  apiKey,
}: {
  prompt: string;
  /** The key just created here, or null when this person can't create one. */
  apiKey: string | null;
}): string {
  return [
    "# 1. Install the Opengeni Developer plugin (Claude Code; Codex and Cursor: see Show details)",
    ...DEVELOPER_PLUGIN_INSTALL.claude,
    "",
    "# 2. Then give your coding agent this prompt",
    prompt,
    "",
    "# 3. The API key goes in your product's server .env, never in client code",
    apiKey
      ? `${API_KEY_ENV_VAR}=${apiKey}`
      : `${API_KEY_ENV_VAR}=<ask an organization owner for an API key>`,
  ].join("\n");
}
