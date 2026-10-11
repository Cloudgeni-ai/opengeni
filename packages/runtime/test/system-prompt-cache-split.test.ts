import { afterEach, describe, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { allAgentCapabilities, type ResolvedAgentConfig } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { inspectPersistentAgentInstructions } from "../src";
import { buildAnthropicRequest } from "../src/anthropic-messages";
import { applyClaudeCodeIdentity } from "../src/claude-code-identity";
import {
  clearStableSystemPromptPrefixes,
  recordStableSystemPromptPrefix,
  splitStableSystemPromptPrefix,
} from "../src/system-prompt-cache-prefix";

const agentConfig: ResolvedAgentConfig = {
  version: 1,
  from: "all",
  capabilities: allAgentCapabilities(),
  unavailable: [],
  identity: null,
  renderer: "opengeni",
  source: "request",
};
const provider = { anthropic: { cacheTtl: "5m" as const } } as never;
const cache = { type: "ephemeral", ttl: "5m" };

function instructions(
  experiment: boolean,
  governance: string,
  extra: Record<string, unknown> = {},
): string {
  return inspectPersistentAgentInstructions(
    testSettings({ sandboxBackend: "docker", experimentSystemPromptCacheSplit: experiment }),
    {
      agentConfig,
      workspaceGovernance: `# Accepted Agent learning settings\n\nKnowledge: Review first.\n\n${governance}`,
      codemodeAvailable: true,
      ...extra,
    },
  ).composed;
}

function body(systemInstructions: string, input: ModelRequest["input"]) {
  return buildAnthropicRequest(
    {
      input,
      systemInstructions,
      modelSettings: {},
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
      handoffs: [],
      outputType: "text",
      tracing: false,
    } as ModelRequest,
    "claude-sonnet-5-5",
    provider,
    true,
  ) as any;
}

const firstTurn: ModelRequest["input"] = [
  { type: "message", role: "user", content: "What is our database port?" },
];
const laterTurn: ModelRequest["input"] = [
  { type: "message", role: "user", content: "What is our database port?" },
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Checking." }],
  },
  { type: "message", role: "user", content: "Thanks, and the host?" },
];

function breakpoints(request: any): any[] {
  return [
    ...(request.tools ?? []),
    ...(request.system ?? []),
    ...request.messages.flatMap((message: any) => message.content),
  ].filter((block) => block.cache_control);
}

afterEach(() => clearStableSystemPromptPrefixes());

describe("system prompt cache split experiment", () => {
  test("off: one system block with one breakpoint, as before", () => {
    const prompt = instructions(false, "Workspace global policy: Answer in Norwegian.");
    const request = body(prompt, firstTurn);
    expect(request.system).toEqual([{ type: "text", text: prompt, cache_control: cache }]);
    expect(request.tools[0].cache_control).toEqual(cache);
    expect(breakpoints(request)).toHaveLength(3);
  });

  test("on: workspaces share a byte-identical stable block that ends with a breakpoint", () => {
    const a = instructions(true, "Workspace global policy: Answer in Norwegian.");
    const b = instructions(true, "Workspace global policy: Use metric units.");
    const requestA = body(a, firstTurn);
    const requestB = body(b, firstTurn);
    expect(requestA.system).toHaveLength(2);
    expect(requestA.system[0].text).toBe(requestB.system[0].text);
    expect(requestA.system[0].text.length).toBeGreaterThan(20_000);
    expect(requestA.system[0].text).not.toContain("Norwegian");
    expect(requestA.system[0].text).not.toContain("Accepted Agent learning settings");
    expect(requestA.system[1].text).toContain("Norwegian");
    expect(requestA.system.map((block: any) => block.text).join("")).toBe(a);
    expect(requestA.system[0].cache_control).toEqual(cache);
    expect(requestA.system[1].cache_control).toEqual(cache);
    // First request: tools, stable prefix, system end, current history.
    expect(requestA.tools[0].cache_control).toEqual(cache);
    expect(breakpoints(requestA)).toHaveLength(4);
  });

  test("on: a later request stays within four breakpoints by dropping the tools one", () => {
    const prompt = instructions(true, "Workspace global policy: Answer in Norwegian.");
    const request = body(prompt, laterTurn);
    expect(request.system[0].cache_control).toEqual(cache);
    expect(request.system[1].cache_control).toEqual(cache);
    expect(request.tools[0].cache_control).toBeUndefined();
    expect(breakpoints(request)).toHaveLength(4);
  });

  test("on: leading developer messages and the title directive stay in the tail", () => {
    const prompt = instructions(true, "Workspace global policy: Answer in Norwegian.");
    const request = body(`${prompt} Title directive for the first call.`, [
      { type: "message", role: "developer", content: "Skill index for this workspace." } as never,
      ...(firstTurn as never[]),
    ]);
    expect(request.system).toHaveLength(3);
    expect(request.system[0].cache_control).toEqual(cache);
    expect(request.system[1].cache_control).toBeUndefined();
    expect(request.system[2].cache_control).toEqual(cache);
    expect(request.system[1].text).toEndWith("Title directive for the first call.");
    expect(breakpoints(request)).toHaveLength(4);
  });

  test("on: workspace environment and turn attachments move after the stable prefix", () => {
    const plain = instructions(true, "Policy.");
    const withEnvironment = instructions(true, "Policy.", {
      workspaceEnvironment: { name: "prod-env-42", variableNames: ["DB_PORT"] },
      fileResourceDownloads: [{}],
    });
    const stable = splitStableSystemPromptPrefix(withEnvironment)![0];
    expect(stable).not.toContain("prod-env-42");
    expect(withEnvironment.indexOf("prod-env-42")).toBeGreaterThan(stable.length);
    // The environment-free prefix of the same configuration is a superset.
    expect(splitStableSystemPromptPrefix(plain)![0].startsWith(stable)).toBe(true);
  });

  test("on: a sandbox-wrapped prompt splits after the deterministic SDK preamble", () => {
    const prompt = instructions(true, "Policy.");
    const wrapped = `Sandbox base.\n\n# Agent instructions\n\n${prompt}\n\n# Filesystem\n/workspace`;
    const [stable, tail] = splitStableSystemPromptPrefix(wrapped)!;
    expect(stable.startsWith("Sandbox base.\n\n# Agent instructions\n\n")).toBe(true);
    expect(tail).toContain("Policy.");
    expect(tail).toEndWith("/workspace");
  });

  test("on: legacy (no agent configuration) prompts split after the shared persona", () => {
    const settings = testSettings({
      sandboxBackend: "none",
      experimentSystemPromptCacheSplit: true,
    });
    const legacy = (governance: string) =>
      inspectPersistentAgentInstructions(settings, { workspaceGovernance: governance }).composed;
    const a = splitStableSystemPromptPrefix(legacy("Policy A."))!;
    const b = splitStableSystemPromptPrefix(legacy("Policy B."))!;
    expect(a[0]).toBe(b[0]);
    expect(a[1]).toContain("Policy A.");
  });

  test("on: the Claude subscription billing block adds no breakpoint", () => {
    const prompt = instructions(true, "Policy.");
    const request = body(prompt, laterTurn);
    applyClaudeCodeIdentity(
      request,
      new Headers(),
      new URL("https://api.anthropic.com/v1/messages"),
      { input: laterTurn } as ModelRequest,
      { accountUuid: "00000000-0000-4000-8000-000000000000", deviceId: "device" } as never,
      { sessionId: "00000000-0000-4000-8000-000000000001", promptId: "prompt" },
    );
    expect(request.system).toHaveLength(3);
    expect(request.system[0].cache_control).toBeUndefined();
    expect(breakpoints(request)).toHaveLength(4);
  });

  test("off: composing records nothing", () => {
    const prompt = instructions(false, "Policy.");
    expect(splitStableSystemPromptPrefix(prompt)).toBeUndefined();
  });

  test("on: caching off or a whitespace-only tail sends one block", () => {
    const prompt = instructions(true, "Policy.");
    const uncached = buildAnthropicRequest(
      {
        input: firstTurn,
        systemInstructions: prompt,
        modelSettings: {},
        tools: [],
        handoffs: [],
        outputType: "text",
        tracing: false,
      } as ModelRequest,
      "claude-sonnet-5-5",
      { anthropic: { cacheTtl: "off" } } as never,
      true,
    ) as any;
    expect(uncached.system).toEqual([{ type: "text", text: prompt }]);
    const stable = splitStableSystemPromptPrefix(prompt)![0];
    expect(splitStableSystemPromptPrefix(`${stable}\n\n  `)).toBeUndefined();
  });

  test("a used prefix is refreshed and survives later records", () => {
    const prompt = instructions(true, "Policy.");
    const stable = splitStableSystemPromptPrefix(prompt)![0];
    for (let index = 0; index < 300; index += 1) {
      if (index % 50 === 0) expect(splitStableSystemPromptPrefix(prompt)![0]).toBe(stable);
      recordStableSystemPromptPrefix(`${"x".repeat(2_048)}${index}`);
    }
    expect(splitStableSystemPromptPrefix(prompt)![0]).toBe(stable);
  });
});
