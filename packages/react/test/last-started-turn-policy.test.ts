import { describe, expect, test } from "bun:test";
import {
  isLastStartedTurnPolicyEvent,
  withServingModel,
  type LastStartedTurnPolicy,
} from "../src/hooks/use-last-started-turn-policy";

describe("isLastStartedTurnPolicyEvent", () => {
  test("only turn.started admits a new last-used policy", () => {
    expect(isLastStartedTurnPolicyEvent({ type: "turn.started" })).toBe(true);
    expect(isLastStartedTurnPolicyEvent({ type: "turn.queued" })).toBe(false);
    expect(isLastStartedTurnPolicyEvent({ type: "turn.completed" })).toBe(false);
    expect(isLastStartedTurnPolicyEvent({ type: "user.message" })).toBe(false);
    expect(isLastStartedTurnPolicyEvent({ type: "session.queue.updated" })).toBe(false);
  });
});

describe("SUB-FAIL-06 lease-backed header policy", () => {
  const preferred: LastStartedTurnPolicy = {
    model: "codex/preferred",
    reasoningEffort: "high",
    latencyMode: "standard",
    turnId: "turn-2",
  };
  const serving = {
    turnId: "turn-2",
    provider: "claude",
    connectionId: null,
    modelId: "claude-sub/fallback",
    preferredModelId: "codex/preferred",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
  };

  test("reload displays the serving model while leaving the accepted preference untouched", () => {
    expect(withServingModel(preferred, serving)).toEqual({
      model: serving.modelId,
      reasoningEffort: "medium",
      latencyMode: "standard",
      turnId: "turn-2",
    });
    expect(preferred.model).toBe("codex/preferred");
  });

  test("earlier-turn selections, missing snapshots and pre-start sessions cannot override the header", () => {
    expect(withServingModel(preferred, { ...serving, turnId: "turn-1" })).toBe(preferred);
    expect(withServingModel(preferred, undefined)).toBe(preferred);
    expect(withServingModel(preferred, null)).toBe(preferred);
    expect(withServingModel(null, serving)).toBeNull();
  });
});
