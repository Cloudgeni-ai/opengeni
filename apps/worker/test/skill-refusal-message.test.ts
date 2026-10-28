import { describe, expect, test } from "bun:test";
import { SkillLifecycleRefusedError } from "@opengeni/db";
import { skillRefusalMessage } from "../src/activities/agent-turn/skill-tools";

describe("skillRefusalMessage", () => {
  test("an out-of-scope removal names the shared-workspace rule and the Skills page", () => {
    const error = new SkillLifecycleRefusedError("42501", "Skill outside accepted learning scope", {
      cause: null,
    });
    const message = skillRefusalMessage(error, {
      destination: "skill",
      reason: "not_permitted",
      skillId: crypto.randomUUID(),
    });
    expect(message).toContain(
      "in a shared workspace, a private chat removes only personal Skills and a shared chat only workspace Skills",
    );
    expect(message).toContain(
      "a workspace Skill or the person's own Skill can still be removed on the Skills page by someone who manages Skills",
    );
    // A Personal workspace owner's chat may remove its workspace Skills
    // (migration 1033), so the refusal no longer claims a blanket rule.
    expect(message).not.toContain("(a private chat removes only personal Skills");
  });
});
