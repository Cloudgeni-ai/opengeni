import { expect, test } from "bun:test";
import { skillReleaseMessage } from "./skill-release-message";

test("preserved Skill heads have an explicit removal warning", () => {
  const receipt = {
    skillId: "skill",
    revisionId: "revision",
    disposition: "preserved" as const,
    eventId: null,
    warning: null,
  };
  expect(skillReleaseMessage([receipt])).toContain("remains active");
  expect(skillReleaseMessage([receipt, { ...receipt, skillId: "another" }])).toContain(
    "2 customized",
  );
  expect(skillReleaseMessage([{ ...receipt, disposition: "deactivated" }])).toBeUndefined();
  expect(skillReleaseMessage(undefined)).toBeUndefined();
});
