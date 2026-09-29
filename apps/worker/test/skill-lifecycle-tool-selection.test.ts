import { describe, expect, test } from "bun:test";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  createWorkspaceSkillTools,
  skillLifecycleToolsSelected,
} from "../src/activities/agent-turn/skill-tools";

// An embedded session created with `firstPartyMcpTools: []` must not receive
// the in-process Skill-management surface (public install, save, publish...).

function definitions(includeLifecycleTools?: boolean) {
  return createWorkspaceSkillTools({
    db: {} as Database,
    settings: testSettings({}),
    accountId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    actor: {
      kind: "agent",
      sessionId: "00000000-0000-4000-8000-000000000003",
      turnId: "00000000-0000-4000-8000-000000000004",
      attemptId: "00000000-0000-4000-8000-000000000005",
      executionGeneration: 1,
    },
    selected: [],
    filesystem: async () => {
      throw new Error("not used");
    },
    modelToolOutputTruncationTokens: () => 10_000,
    ...(includeLifecycleTools === undefined ? {} : { includeLifecycleTools }),
  }).map((definition) => definition.modelName);
}

describe("Skill lifecycle tool selection", () => {
  test("an empty effective first-party selection withholds the lifecycle tools", () => {
    expect(skillLifecycleToolsSelected([])).toBe(false);
    expect(definitions(false)).toEqual(["skill_read"]);
  });

  test("any non-empty selection keeps the historical Skill tool set", () => {
    expect(skillLifecycleToolsSelected(["set_session_title"])).toBe(true);
    const names = definitions();
    expect(names).toEqual(definitions(true));
    expect([...names].sort()).toEqual([
      "skill_checkout",
      "skill_install",
      "skill_publish",
      "skill_read",
      "skill_remove",
      "skill_save",
      "skill_search",
    ]);
  });
});
