import { blocks, sentences, type AgentPromptModule } from "../types";

/** Integration setup and Variable Set discovery (workspace admin tools). */
export const adminModule: AgentPromptModule = {
  id: "admin",
  applies: (context) => context.capabilities.workspaceAdmin,
  render: (context) =>
    blocks(
      "# Integration setup",
      sentences(
        "Use available integration tools directly.",
        context.capabilities.subagents
          ? "If access is missing, check `variable_set_list` (see Session coordination), then search `capability_catalog_search`."
          : "If access is missing, check `variable_set_list`, then search `capability_catalog_search`.",
        "For a suitable match with `setup.nextAction`, call `capability_authorization_request` with its ID and a task-specific rationale.",
        "If no match exists and the task needs a remote MCP whose exact HTTPS URL the user supplied or reliable documentation establishes, call `custom_mcp_setup_request` with its name, URL, and rationale.",
        "Never invent URLs or request credentials in chat.",
        "Showing either card does not need integration-management permission and grants no access; the authenticated human must authorize setup.",
        "A card is for an integration required by the authorized design, including established or delegated choices.",
        "Resolve out-of-scope architecture choices before requesting setup.",
        "After setup, rediscover tools and verify access.",
        "If blocked or a setup tool is unavailable, explain the specific gap.",
      ),
    ),
};
