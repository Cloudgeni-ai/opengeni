import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import {
  allAgentCapabilities,
  type ResolvedAgentCapabilities,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenGeniAgent } from "../src/index";

type Node = {
  properties?: Record<string, Node>;
  required?: string[];
  enum?: unknown[];
  items?: Node;
};

function config(overrides: Partial<ResolvedAgentCapabilities>): ResolvedAgentConfig {
  return {
    version: 1,
    from: "all",
    capabilities: { ...allAgentCapabilities(), ...overrides },
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "request",
  };
}

// The schema as sent to the model, not the zod source.
async function wireSchema(agentConfig: ResolvedAgentConfig | null) {
  const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
    ...(agentConfig ? { agentConfig } : {}),
    skillCatalog: [],
  });
  const tools = await agent.getAllTools(new RunContext());
  const tool = tools.find((candidate) => candidate.name === "request_human_input") as
    | { parameters: Node; strict?: boolean }
    | undefined;
  if (!tool) throw new Error("request_human_input is not attached");
  return { schema: tool.parameters, strict: tool.strict };
}

function without(full: Node, secrets: boolean, skillReview: boolean): Node {
  const schema = structuredClone(full);
  const question = schema.properties!.questions!.items!;
  const drop = (field: string) => {
    delete question.properties![field];
    question.required = question.required!.filter((name) => name !== field);
  };
  if (!secrets) {
    drop("secret");
    question.properties!.kind!.enum = question.properties!.kind!.enum!.filter(
      (value) => value !== "secret",
    );
  }
  if (!skillReview) drop("skillReview");
  return schema;
}

describe("request_human_input as sent", () => {
  test("a reduced schema is the full one minus only the disabled fields", async () => {
    const full = await wireSchema(null);
    expect((await wireSchema(config({}))).schema).toEqual(full.schema);
    const size = (schema: Node) => JSON.stringify(schema).length;
    for (const [label, overrides, secrets, skillReview] of [
      ["secrets, Skills read", { skills: "read" }, true, false],
      ["no secrets, Skill management", { secrets: false }, false, true],
      ["neither", { secrets: false, skills: false }, false, false],
    ] as const) {
      const reduced = await wireSchema(config(overrides));
      expect({ label, schema: reduced.schema }).toEqual({
        label,
        schema: without(full.schema, secrets, skillReview),
      });
      expect(reduced.strict).toBe(full.strict);
      expect(size(reduced.schema)).toBeLessThan(size(full.schema));
    }
  });
});
