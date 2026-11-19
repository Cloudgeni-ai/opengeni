import { describe, expect, test } from "bun:test";
import {
  AGENT_BOOLEAN_CAPABILITY_IDS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  FIRST_PARTY_MCP_TOOL_NAMES,
  agentConfigFirstPartyMcpTools,
  resolveAgentConfig,
  resolveAgentToolFamilies,
  userSetupCardUnpostedMessage,
  userSetupBlocker,
  type AgentCapabilities,
  type FirstPartyMcpToolName,
  type ResolveAgentConfigInput,
} from "../src/index";

const CARD = "capability_authorization_request";

function resolve(capabilities: AgentCapabilities) {
  return resolveAgentConfig({
    creator: "api",
    workspace: { defaults: null, humanInputEnabled: true },
    deployment: { unavailable: {} } satisfies ResolveAgentConfigInput["deployment"],
    goal: false,
    request: { capabilities },
  }).config!;
}

/** What a turn of a new session with this configuration selects. */
function turnTools(capabilities: AgentCapabilities): FirstPartyMcpToolName[] {
  const config = resolve(capabilities);
  return resolveAgentToolFamilies(config).firstPartyTools(
    agentConfigFirstPartyMcpTools(config, DEFAULT_FIRST_PARTY_MCP_TOOLS),
  );
}

/**
 * First-party tools whose description or results tell the agent to call the
 * Connect card tool (fleet notices and refusals, catalog setup actions, the
 * enroll-token and provisioning guidance, custom MCP setup).
 */
const NAMES_THE_CARD_TOOL: readonly FirstPartyMcpToolName[] = [
  "capability_catalog_search",
  "custom_mcp_setup_request",
  "sandboxes_list",
  "sandbox_attach",
  "sandbox_swap",
  "run_on",
  "sandbox_provision",
  "connected_machine_enroll_token",
  "connected_machine_enable_screen_control",
];

describe("the Connect card tool follows what the person may have to connect", () => {
  test("an embedding host's agent without workspace admin keeps the card, not the admin tools", () => {
    const tools = turnTools({ from: "all", workspaceAdmin: false });
    expect(tools).toContain(CARD);
    expect(tools).toContain("github_connect_link");
    expect(tools).not.toContain("capability_catalog_search");
    expect(tools).not.toContain("custom_mcp_setup_request");
    expect(tools).not.toContain("sandboxes_list");
  });

  test("workspace connectors or workspace admin alone each bring the card", () => {
    expect(turnTools({ from: "none", workspaceConnectors: true })).toContain(CARD);
    expect(turnTools({ from: "none", workspaceAdmin: true })).toContain(CARD);
    expect(turnTools("all")).toContain(CARD);
  });

  test("an agent that could use nothing a card connects has no card", () => {
    expect(turnTools("none")).not.toContain(CARD);
    expect(turnTools({ from: "none", browser: true })).not.toContain(CARD);
    expect(
      turnTools({ from: "all", workspaceAdmin: false, workspaceConnectors: false }),
    ).not.toContain(CARD);
  });

  test("a session stored without the card tool keeps its exact tool list", () => {
    // Created before the card came with connectors: its explicit selection
    // was filtered without it, and a turn never adds it back.
    const config = resolve({ from: "all", workspaceAdmin: false });
    const stored = agentConfigFirstPartyMcpTools(config, DEFAULT_FIRST_PARTY_MCP_TOOLS).filter(
      (tool) => tool !== CARD,
    );
    const tools = resolveAgentToolFamilies(config).firstPartyTools(stored);
    expect(tools).not.toContain(CARD);
    expect(tools.filter((tool) => tool !== "wait_for_input")).toEqual(
      stored.filter((tool) => tool !== "wait_for_input"),
    );
  });

  test("no capability set has a tool that names the card tool without the card tool", () => {
    for (const connectors of [false, true]) {
      for (const admin of [false, true]) {
        for (const from of ["all", "none"] as const) {
          for (const other of AGENT_BOOLEAN_CAPABILITY_IDS) {
            const capabilities = {
              from,
              [other]: from === "none",
              workspaceConnectors: connectors,
              workspaceAdmin: admin,
            } as AgentCapabilities;
            const families = resolveAgentToolFamilies(resolve(capabilities));
            for (const tool of NAMES_THE_CARD_TOOL) {
              if (!families.allowsFirstPartyTool(tool)) continue;
              expect({ capabilities, tool, card: families.allowsFirstPartyTool(CARD) }).toEqual({
                capabilities,
                tool,
                card: true,
              });
            }
          }
        }
      }
    }
    for (const tool of NAMES_THE_CARD_TOOL) expect(FIRST_PARTY_MCP_TOOL_NAMES).toContain(tool);
  });

  test("a refusal's fallback names the card tool only when the agent may have it", () => {
    const blocker = userSetupBlocker("personal_machine_permission_required")!;
    const without = userSetupCardUnpostedMessage(blocker, false);
    expect(without).not.toContain(CARD);
    expect(without).toContain(blocker.nextStep);
    const withCard = userSetupCardUnpostedMessage(blocker, true);
    expect(withCard).toContain(`${CARD} (capabilityId ${blocker.capabilityId})`);
    expect(withCard).not.toContain("if that tool is available");
    expect(userSetupCardUnpostedMessage(blocker)).toContain("if that tool is available");
  });
});
