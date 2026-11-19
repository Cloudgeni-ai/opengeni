import {
  blocks,
  sentences,
  toolAvailable,
  type AgentPromptContext,
  type AgentPromptModule,
} from "../types";

/**
 * Integration setup. With `workspaceAdmin` it covers the catalog, Connect
 * cards and custom MCP setup; a sentence naming a setup tool renders unless
 * the attempt proved it absent. Without it, an agent with
 * `workspaceConnectors` still has the Connect card tool (it is derived, like
 * `wait_for_input`), so the section explains just that card and never names
 * the admin-only catalog or custom MCP tools.
 */
export const adminModule: AgentPromptModule = {
  id: "admin",
  applies: (context) => context.capabilities.workspaceAdmin || connectCardOnly(context),
  render: (context) =>
    context.capabilities.workspaceAdmin ? renderAdmin(context) : renderConnectCard(context),
};

/** The Connect card tool without workspace administration. */
function connectCardOnly(context: AgentPromptContext): boolean {
  return (
    context.capabilities.workspaceConnectors &&
    toolAvailable(context, "capability_authorization_request")
  );
}

function renderAdmin(context: AgentPromptContext): string {
  const catalog = toolAvailable(context, "capability_catalog_search");
  const authorization = toolAvailable(context, "capability_authorization_request");
  const customMcp = toolAvailable(context, "custom_mcp_setup_request");
  const github = toolAvailable(context, "github_connect_link");
  const setupCards = authorization || customMcp;
  const discovery = catalog
    ? "If access is missing, search `capability_catalog_search`."
    : undefined;
  return blocks(
    "# Integration setup",
    sentences(
      "Use available integration tools directly.",
      discovery,
      authorization &&
        "For a suitable match with `setup.nextAction`, call `capability_authorization_request` with its ID and a task-specific rationale.",
      customMcp &&
        "If no match exists and the task needs a remote MCP whose exact HTTPS URL the user supplied or reliable documentation establishes, call `custom_mcp_setup_request` with its name, URL, and rationale.",
      "Never invent URLs or request credentials in chat.",
      context.capabilities.secrets &&
        context.capabilities.humanInput &&
        'For a password, key or code only the user has, use a `kind: "secret"` question in `request_human_input`; you get a saved reference back, never the value.',
      setupCards &&
        "Showing either card does not need integration-management permission and grants no access; the authenticated human must authorize setup.",
      setupCards &&
        "A card is for an integration required by the authorized design, including established or delegated choices.",
      setupCards && "Resolve out-of-scope architecture choices before requesting setup.",
      setupCards && "After setup, rediscover tools and verify access.",
      github &&
        context.resources.personalGitHub &&
        "For GitHub, `github_connect_link` reports both identities: 'connect my GitHub' or 'do it as me' means the person's own account (Your GitHub), and 'install the GitHub app' means the workspace's GitHub app.",
      "If a setup tool is unavailable, give the user the exact next step; if they can't fix it, explain the specific gap and who can.",
    ),
  );
}

function renderConnectCard(context: AgentPromptContext): string {
  return blocks(
    "# Integration setup",
    sentences(
      "When the person must connect something for the task, such as an integration or their own computer, call `capability_authorization_request` with the capability ID that a tool result, notice or its description gives, and a task-specific rationale.",
      "Showing the card needs no integration-management permission and grants no access; the person completes setup.",
      "Never invent URLs or request credentials in chat.",
      "After setup, rediscover tools and verify access.",
      toolAvailable(context, "github_connect_link") &&
        context.resources.personalGitHub &&
        "For GitHub, `github_connect_link` reports both identities: 'connect my GitHub' or 'do it as me' means the person's own account (Your GitHub), and 'install the GitHub app' means the workspace's GitHub app.",
    ),
  );
}
