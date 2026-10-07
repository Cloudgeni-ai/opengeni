import { blocks, sentences, toolAvailable, type AgentPromptModule } from "../types";

/**
 * Integration setup and Variable Set discovery (workspace admin tools). A
 * sentence naming a setup tool renders unless the attempt proved it absent.
 */
export const adminModule: AgentPromptModule = {
  id: "admin",
  applies: (context) => context.capabilities.workspaceAdmin,
  render: (context) => {
    const variableSets = toolAvailable(context, "variable_set_list");
    const catalog = toolAvailable(context, "capability_catalog_search");
    const authorization = toolAvailable(context, "capability_authorization_request");
    const customMcp = toolAvailable(context, "custom_mcp_setup_request");
    const setupCards = authorization || customMcp;
    const seeSessions = context.capabilities.subagents ? " (see Session coordination)" : "";
    const discovery =
      variableSets && catalog
        ? `If access is missing, check \`variable_set_list\`${seeSessions}, then search \`capability_catalog_search\`.`
        : variableSets
          ? `If access is missing, check \`variable_set_list\`${seeSessions}.`
          : catalog
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
        setupCards &&
          "Showing either card does not need integration-management permission and grants no access; the authenticated human must authorize setup.",
        setupCards &&
          "A card is for an integration required by the authorized design, including established or delegated choices.",
        setupCards && "Resolve out-of-scope architecture choices before requesting setup.",
        setupCards && "After setup, rediscover tools and verify access.",
        "If blocked or a setup tool is unavailable, explain the specific gap.",
      ),
    );
  },
};
