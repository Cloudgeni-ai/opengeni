import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import {
  allAgentCapabilities,
  noneAgentCapabilities,
  RequestHumanInputToolInput,
  type ResolvedAgentCapabilities,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildOpenGeniAgent,
  HUMAN_INPUT_TOOL_NAME,
  serializeHumanInputRequests,
} from "../src/index";

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
  // Asking questions is one of the essentials of "none"; humanInput: false
  // (or an unattended session) is how an embedder turns it off.
  test('"none" keeps the question tool and humanInput: false removes it', async () => {
    const attached = async (capabilities: ResolvedAgentCapabilities) => {
      const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
        agentConfig: { ...config({}), from: "none", capabilities },
        skillCatalog: [],
      });
      const tools = await agent.getAllTools(new RunContext());
      return tools.some((tool) => tool.name === HUMAN_INPUT_TOOL_NAME);
    };
    expect(await attached(noneAgentCapabilities())).toBe(true);
    expect(await attached({ ...noneAgentCapabilities(), humanInput: false })).toBe(false);
  });

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

  test("no variant carries allowOther or the $schema marker", async () => {
    for (const agentConfig of [
      null,
      config({}),
      config({ skills: "read" }),
      config({ secrets: false, skills: false }),
    ]) {
      const { schema } = await wireSchema(agentConfig);
      const question = schema.properties!.questions!.items!;
      expect(Object.keys(schema)).not.toContain("$schema");
      expect(Object.keys(question.properties!)).not.toContain("allowOther");
      expect(question.required).not.toContain("allowOther");
      // Every other question field is still sent.
      expect(Object.keys(question.properties!).sort()).toEqual([...question.required!].sort());
    }
  });

  test("a call without allowOther still parses, and choice requests still offer Other", async () => {
    const call = {
      questions: [
        {
          id: "pick",
          kind: "single_select",
          prompt: "Which one?",
          label: null,
          helpText: null,
          skillReview: null,
          secret: null,
          options: [{ id: "a", label: "A", description: null, recommended: null, preview: null }],
          required: true,
          confirm: null,
          validation: null,
        },
      ],
      allowSkip: false,
      expiresInSeconds: null,
    };
    expect(RequestHumanInputToolInput.parse(call).questions[0]!.allowOther).toBe(false);
    const [serialized] = serializeHumanInputRequests([
      {
        name: HUMAN_INPUT_TOOL_NAME,
        rawItem: {
          callId: "pick-call",
          name: HUMAN_INPUT_TOOL_NAME,
          arguments: JSON.stringify(call),
        },
      },
    ]);
    expect(serialized!.input.questions[0]!.allowOther).toBe(true);
  });
});
