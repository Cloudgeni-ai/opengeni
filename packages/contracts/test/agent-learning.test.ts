import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AGENT_LEARNING,
  AgentLearningOverrides,
  agentLearningDefaultsFromLegacy,
  agentLearningDestinationMode,
  patchAgentLearningOverrides,
  resolveAgentLearningPolicy,
} from "../src/agent-learning";

describe("agent learning policy", () => {
  test("ordinary chat stays automatic while a scheduled task reviews knowledge only", () => {
    const chat = resolveAgentLearningPolicy(DEFAULT_AGENT_LEARNING, {});
    const task = resolveAgentLearningPolicy(DEFAULT_AGENT_LEARNING, {
      knowledge: "review_first",
    });
    expect(chat.knowledge).toEqual({ mode: "automatic", inherited: true });
    expect(task.knowledge).toEqual({ mode: "review_first", inherited: false });
    expect(task.instructions).toEqual({ mode: "review_first", inherited: true });
    expect(task.skills).toEqual(chat.skills);
  });

  test("explicit context choice wins even over an off or review-first default", () => {
    const effective = resolveAgentLearningPolicy(
      { knowledge: "off", instructions: "review_first", skills: "automatic" },
      { knowledge: "automatic", skills: "off" },
    );
    expect(effective.knowledge).toEqual({ mode: "automatic", inherited: false });
    expect(effective.skills).toEqual({ mode: "off", inherited: false });
  });

  test("Use default removes only that override and leaves input records untouched", () => {
    const prior = { knowledge: "review_first", skills: "off" } as const;
    const next = patchAgentLearningOverrides(prior, { knowledge: "inherit" });
    expect(next).toEqual({ skills: "off" });
    expect(prior).toEqual({ knowledge: "review_first", skills: "off" });
    expect(resolveAgentLearningPolicy(DEFAULT_AGENT_LEARNING, next).knowledge.inherited).toBe(true);
    expect(AgentLearningOverrides.safeParse({ knowledge: "inherit" }).success).toBe(false);
  });

  test("a resolved policy is detached from later mutations to its inputs", () => {
    const defaults = { ...DEFAULT_AGENT_LEARNING };
    const context = { knowledge: "review_first" } as { knowledge: "review_first" | "automatic" };
    const accepted = resolveAgentLearningPolicy(defaults, context);
    defaults.skills = "automatic";
    context.knowledge = "automatic";
    expect(accepted.knowledge.mode).toBe("review_first");
    expect(accepted.skills.mode).toBe("review_first");
  });

  test("legacy migration preserves opt-outs without accidentally disabling Knowledge", () => {
    expect(agentLearningDefaultsFromLegacy({})).toEqual(DEFAULT_AGENT_LEARNING);
    expect(agentLearningDefaultsFromLegacy({ workspaceMode: "off" })).toEqual({
      knowledge: "automatic",
      instructions: "off",
      skills: "off",
    });
    expect(
      agentLearningDefaultsFromLegacy({ memoryEnabled: false, workspaceMode: "automatic" }),
    ).toEqual({ knowledge: "off", instructions: "automatic", skills: "automatic" });
    expect(agentLearningDestinationMode("review_first")).toBe("suggest");
  });

  test("unknown categories and malformed policy never silently become automatic", () => {
    expect(() => patchAgentLearningOverrides({}, { knowledge: "allow" } as never)).toThrow();
    expect(() =>
      resolveAgentLearningPolicy({ ...DEFAULT_AGENT_LEARNING, email: "automatic" } as never, {}),
    ).toThrow();
    expect(() => agentLearningDefaultsFromLegacy({ memoryEnabled: "false" } as never)).toThrow();
  });
});
