import { describe, expect, test } from "bun:test";
import {
  CreateScheduledTaskRequest,
  SCHEDULED_TASK_AGENT_CONFIG_MAX_BYTES,
  SessionSkills,
  UpdateScheduledTaskRequest,
} from "../src/index";

const generated = {
  name: "Nightly review",
  schedule: { type: "manual" },
  runMode: "new_session_per_run",
  overlapPolicy: "skip",
};

/** Sixteen valid Skills of about 9.6 KB each: about 150 KB in total. */
function inlineSkills(count = 16, bodyBytes = 9_600) {
  return Array.from({ length: count }, (_, index) => ({
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: review-step-${index}\ndescription: Review step ${index}.\n---\n${"r".repeat(bodyBytes)}\n`,
      },
    ],
  }));
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** About 150 KB of UTF-8 in instructions alone, within its character limit. */
const oversizedInstructions = "€".repeat(50_000);

describe("scheduled task inline Skills", () => {
  test("are bounded by the Skill limits, not by the agent config cap", () => {
    const skills = inlineSkills();
    expect(utf8Bytes(skills)).toBeGreaterThan(SCHEDULED_TASK_AGENT_CONFIG_MAX_BYTES);
    // The same Skills are valid on session create.
    expect(SessionSkills.safeParse(skills).success).toBe(true);

    const parsed = CreateScheduledTaskRequest.safeParse({
      ...generated,
      agentConfig: { prompt: "Review", skills },
    });
    expect(parsed.success).toBe(true);
    expect(
      (parsed.data as { agentConfig: { skills?: unknown[] } }).agentConfig.skills,
    ).toHaveLength(16);
  });

  test("an update replacing the config takes the same Skills", () => {
    const parsed = UpdateScheduledTaskRequest.safeParse({
      agentConfig: { prompt: "Review", skills: inlineSkills() },
    });
    expect(parsed.success).toBe(true);
  });

  test.each([
    ["without Skills", undefined],
    ["next to Skills", inlineSkills(2, 1_000)],
  ])("the rest of the config keeps its cap %s", (_label, skills) => {
    const agentConfig = {
      prompt: "Review",
      agent: { instructions: oversizedInstructions },
      ...(skills ? { skills } : {}),
    };
    for (const result of [
      CreateScheduledTaskRequest.safeParse({ ...generated, agentConfig }),
      UpdateScheduledTaskRequest.safeParse({ agentConfig }),
    ]) {
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(
        `agent config exceeds ${SCHEDULED_TASK_AGENT_CONFIG_MAX_BYTES} UTF-8 bytes`,
      );
    }
  });

  test("Skills still respect the per-config Skill count", () => {
    expect(
      CreateScheduledTaskRequest.safeParse({
        ...generated,
        agentConfig: { prompt: "Review", skills: inlineSkills(33, 10) },
      }).success,
    ).toBe(false);
  });
});
