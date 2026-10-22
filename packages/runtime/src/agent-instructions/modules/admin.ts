import { blocks, sentences, toolAvailable, type AgentPromptModule } from "../types";

/**
 * Integration setup (workspace admin tools). A
 * sentence naming a setup tool renders unless the attempt proved it absent.
 */
export const adminModule: AgentPromptModule = {
  id: "admin",
  applies: (context) => context.capabilities.workspaceAdmin,
  render: (context) => {
    const catalog = toolAvailable(context, "capability_catalog_search");
    const authorization = toolAvailable(context, "capability_authorization_request");
    const customMcp = toolAvailable(context, "custom_mcp_setup_request");
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
        "If blocked or a setup tool is unavailable, explain the specific gap.",
      ),
    );
  },
};
