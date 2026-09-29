import { describe, expect, test } from "bun:test";
import { Runner } from "@openai/agents";
import { resolveDisabledBuiltinTools } from "@opengeni/contracts";
import { buildOpenGeniAgent } from "@opengeni/runtime";
import { assistantMessage, ScriptedModel, testSettings } from "@opengeni/testing";
import { normalizeXaiSubscriptionRequestBody } from "@opengeni/xai-subscription";
import {
  builtinToolSwitchesForTurn,
  hostedWebSearchForTurn,
  xaiHostedSearchForTurn,
} from "../src/activities/agent-turn/tool-policy";

// Session/workspace opt-outs must remove the provider-hosted tool from the
// model request itself, not only from OpenGeni's tool policy.

async function requestToolTypes(
  hostedWebSearch: boolean,
  humanInputEnabled = true,
): Promise<string[]> {
  const model = new ScriptedModel([{ output: [assistantMessage("ok", "final")] }]);
  const agent = buildOpenGeniAgent(testSettings({ webSearchEnabled: true }), [], {
    model,
    skillCatalog: [],
    hostedWebSearch,
    humanInputEnabled,
  });
  const result = await new Runner({ tracingDisabled: true }).run(agent, "hi", { maxTurns: 2 });
  expect(result.finalOutput).toBe("ok");
  return (model.requests[0]?.tools ?? []).map((tool) =>
    tool.type === "hosted_tool" ? `hosted:${tool.name}` : `${tool.type}:${tool.name}`,
  );
}

describe("built-in tool opt-outs", () => {
  test("children keep every parent opt-out and can only add more", () => {
    expect(resolveDisabledBuiltinTools(undefined, undefined)).toBeUndefined();
    expect(resolveDisabledBuiltinTools(["web_search"], undefined)).toEqual(["web_search"]);
    expect(resolveDisabledBuiltinTools([], ["human_input"])).toEqual(["human_input"]);
    expect(resolveDisabledBuiltinTools(["web_search"], ["human_input"])).toEqual([
      "human_input",
      "web_search",
    ]);
  });

  test("workspace settings and session opt-outs each only narrow", () => {
    expect(builtinToolSwitchesForTurn({}, undefined)).toEqual({
      agentHumanInputEnabled: true,
      agentWebSearchEnabled: true,
    });
    expect(builtinToolSwitchesForTurn({}, ["human_input", "web_search"])).toEqual({
      agentHumanInputEnabled: false,
      agentWebSearchEnabled: false,
    });
    expect(builtinToolSwitchesForTurn({ agentWebSearchEnabled: false }, ["human_input"])).toEqual({
      agentHumanInputEnabled: false,
      agentWebSearchEnabled: false,
    });
  });

  test("an opted-out turn sends no hosted web_search tool to the provider", async () => {
    const on = await requestToolTypes(hostedWebSearchForTurn(null, true, true));
    const off = await requestToolTypes(hostedWebSearchForTurn(null, true, false));
    expect(on.some((tool) => tool.includes("web_search"))).toBe(true);
    expect(off.some((tool) => tool.includes("web_search"))).toBe(false);
  });

  test("an opted-out turn sends no request_human_input tool", async () => {
    const switches = builtinToolSwitchesForTurn({}, ["human_input"]);
    expect(await requestToolTypes(false, true)).toContain("function:request_human_input");
    expect(await requestToolTypes(false, switches.agentHumanInputEnabled)).not.toContain(
      "function:request_human_input",
    );
  });

  test("the SuperGrok transport stops appending hosted search when opted out", () => {
    const tools = (enabled: boolean) =>
      (
        normalizeXaiSubscriptionRequestBody(
          { model: "grok-4", tools: [] },
          (slug) => slug,
          xaiHostedSearchForTurn(true, enabled),
        ).tools as Array<{ type: string }> | undefined
      )?.map((tool) => tool.type) ?? [];
    expect(tools(true)).toEqual(["web_search", "x_search"]);
    expect(tools(false)).toEqual([]);
    expect(xaiHostedSearchForTurn(false, true)).toEqual({ webSearch: false, xSearch: false });
  });
});
