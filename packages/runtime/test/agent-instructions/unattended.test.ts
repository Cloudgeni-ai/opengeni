import { describe, expect, test } from "bun:test";
import {
  allAgentCapabilities,
  noneAgentCapabilities,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import {
  UNATTENDED_SESSION_GUIDANCE,
  buildOpenGeniAgent,
  inspectPersistentAgentInstructions,
  type BuildAgentOptions,
} from "../../src/index";
import { HUMAN_INPUT_TOOL_NAME } from "../../src/run-events";
import { LEGACY_PROMPT_CASES } from "./legacy-cases";
import { ALL_RESOURCES, promptSentences } from "./prompt-sentences";

const modularConfig: ResolvedAgentConfig = {
  version: 1,
  from: "all",
  capabilities: allAgentCapabilities(),
  unavailable: [],
  identity: null,
  renderer: "opengeni",
  source: "request",
};

const settings = testSettings();

function composed(options: BuildAgentOptions): string {
  return inspectPersistentAgentInstructions(settings, options).composed;
}

describe("unattended sessions (model-free)", () => {
  test("the guidance is general: it names no tool, workflow or task shape", () => {
    expect(UNATTENDED_SESSION_GUIDANCE).not.toMatch(
      /\bgit\b|branch|\bmain\b|master|develop|commit|AGENTS\.md|maintainer|sign-off|benchmark|request_human_input|wait_for_input/iu,
    );
  });

  for (const [name, options] of Object.entries(LEGACY_PROMPT_CASES)) {
    if (options.unattended) continue;
    test(`legacy ${name}: only an unattended session carries the guidance`, () => {
      const interactive = composed(options);
      const unattended = composed({ ...options, unattended: true });
      expect(interactive).not.toContain(UNATTENDED_SESSION_GUIDANCE);
      expect(composed({ ...options, unattended: false })).toBe(interactive);
      expect(unattended).toContain(UNATTENDED_SESSION_GUIDANCE);
      // The guidance is the only addition, inside the non-bypassable CORE.
      expect(unattended.replace(` ${UNATTENDED_SESSION_GUIDANCE}`, "")).toBe(interactive);
      const core = inspectPersistentAgentInstructions(settings, {
        ...options,
        unattended: true,
      }).layers.find((layer) => layer.id === "persona_and_core");
      expect(core?.content).toContain(UNATTENDED_SESSION_GUIDANCE);
    });
  }

  test("modular: the unattended module renders only for an unattended session", () => {
    const base = { agentConfig: modularConfig };
    const interactive = inspectPersistentAgentInstructions(settings, base);
    const unattended = inspectPersistentAgentInstructions(settings, { ...base, unattended: true });
    const modules = (inspection: typeof interactive) =>
      inspection.layers
        .find((layer) => layer.id === "operational_contract")
        ?.modules?.map((module) => module.id) ?? [];
    expect(modules(interactive)).not.toContain("unattended");
    expect(interactive.composed).not.toContain(UNATTENDED_SESSION_GUIDANCE);
    expect(modules(unattended).at(-1)).toBe("unattended");
    expect(unattended.composed).toContain(`# Unattended session\n\n${UNATTENDED_SESSION_GUIDANCE}`);
    expect(composed({ ...base, unattended: false })).toBe(interactive.composed);
  });

  test("modular with no capabilities: only the module is added", () => {
    const base = {
      agentConfig: {
        ...modularConfig,
        from: "none" as const,
        capabilities: noneAgentCapabilities(),
      },
    };
    const interactive = composed(base);
    const unattended = composed({ ...base, unattended: true });
    expect(interactive).not.toContain(UNATTENDED_SESSION_GUIDANCE);
    expect(composed({ ...base, unattended: false })).toBe(interactive);
    expect(
      unattended.replace(`\n\n# Unattended session\n\n${UNATTENDED_SESSION_GUIDANCE}`, ""),
    ).toBe(interactive);
  });

  test("modular: no clause offers request_human_input when unattended", () => {
    const options = {
      agentConfig: modularConfig,
      agentPromptResources: { ...ALL_RESOURCES, secretReferences: true },
    };
    expect(composed(options)).toContain("request_human_input");
    expect(
      composed({
        ...options,
        agentPromptResources: { ...options.agentPromptResources, unattended: true },
      }),
    ).not.toContain("request_human_input");
  });

  test("both compositions add the same sentences", () => {
    const added = (before: string, after: string) => {
      const kept = promptSentences(before);
      return [...promptSentences(after)].filter((sentence) => !kept.has(sentence)).sort();
    };
    const legacy = added(composed({}), composed({ unattended: true }));
    const modular = added(
      composed({ agentConfig: modularConfig }),
      composed({ agentConfig: modularConfig, unattended: true }),
    );
    expect(legacy.length).toBeGreaterThan(0);
    expect(modular).toEqual(legacy);
  });

  test("an unattended agent is not given the human-input tool", () => {
    const tools = (options: BuildAgentOptions) =>
      buildOpenGeniAgent(settings, [], options).tools.map((tool) => tool.name);
    expect(tools({})).toContain(HUMAN_INPUT_TOOL_NAME);
    expect(tools({ unattended: false })).toEqual(tools({}));
    expect(tools({ unattended: true })).toEqual(
      tools({}).filter((name) => name !== HUMAN_INPUT_TOOL_NAME),
    );
    expect(tools({ agentConfig: modularConfig, unattended: true })).not.toContain(
      HUMAN_INPUT_TOOL_NAME,
    );
  });
});
