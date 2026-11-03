import { describe, expect, test } from "bun:test";
import { noneAgentCapabilities, type ResolvedAgentConfig, type ToolRef } from "@opengeni/contracts";
import { turnToolRouterExpected } from "../src/activities/agent-turn/tool-router-expectation";

const config: ResolvedAgentConfig = {
  version: 1,
  from: "none",
  capabilities: noneAgentCapabilities(),
  unavailable: [],
  identity: null,
  renderer: "opengeni",
  source: "request",
};

const eagerProduct: ToolRef = { kind: "mcp", id: "customer-product", eager: true } as ToolRef;
const opengeni: ToolRef = { kind: "mcp", id: "opengeni" } as ToolRef;

function expected(overrides: Partial<Parameters<typeof turnToolRouterExpected>[0]> = {}) {
  return turnToolRouterExpected({
    agentConfig: config,
    routerInHistory: false,
    toolRefs: [eagerProduct, opengeni],
    remoteFirstPartyTools: ["set_session_title", "wait_for_input"],
    functionToolNames: ["request_human_input"],
    preparationIndependentToolNames: ["request_human_input"],
    mediaTools: false,
    ...overrides,
  });
}

describe("turnToolRouterExpected", () => {
  test("nothing deferred: eager product tools, harness tools and the title tool", () => {
    expect(expected()).toBe(false);
  });

  test("any doubt keeps the router", () => {
    expect(expected({ agentConfig: null })).toBe(true);
    expect(expected({ routerInHistory: true })).toBe(true);
    expect(expected({ mediaTools: true })).toBe(true);
    // A product server that is not eager is searchable.
    expect(
      expected({ toolRefs: [{ kind: "mcp", id: "customer-product" } as ToolRef, opengeni] }),
    ).toBe(true);
    // A deferred first-party tool other than the title and harness tools.
    expect(expected({ remoteFirstPartyTools: ["knowledge_search"] })).toBe(true);
    // An unknown function tool.
    expect(expected({ functionToolNames: ["image_generation"] })).toBe(true);
  });

  test("first-party tools listed eagerly do not need the router", () => {
    expect(
      expected({
        toolRefs: [
          eagerProduct,
          { kind: "mcp", id: "opengeni", eager: ["knowledge_search"] } as ToolRef,
        ],
        remoteFirstPartyTools: ["knowledge_search"],
      }),
    ).toBe(false);
  });
});
