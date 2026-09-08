import { expect, test } from "bun:test";
import { skillReleaseMessage, skillInstallationMessage } from "./skill-release-message";

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

test("installed sources do not imply their pending Skill changes are live", () => {
  const receipt = {
    operationId: "operation",
    skillId: "skill",
    revisionId: "revision",
    outcome: "pending" as const,
    replayed: false,
  };
  expect(skillInstallationMessage([receipt], undefined)).toBe(
    "1 Skill change is awaiting approval.",
  );
  expect(skillInstallationMessage([receipt, receipt], undefined)).toBe(
    "2 Skill changes are awaiting approval.",
  );
  expect(skillInstallationMessage([{ ...receipt, outcome: "preserved" }], undefined)).toBe(
    "Your customized Skill was preserved.",
  );
  expect(skillInstallationMessage([{ ...receipt, outcome: "applied" }], undefined)).toBeUndefined();
  expect(skillInstallationMessage(undefined, undefined)).toBeUndefined();
  expect(
    skillInstallationMessage(
      [receipt],
      [
        {
          skillId: "other",
          revisionId: "old",
          disposition: "preserved",
          eventId: null,
          warning: null,
        },
      ],
    ),
  ).toContain("awaiting approval. The source was removed");
});

test("final publication supersedes the original deferred receipt", () => {
  const deferred = {
    operationId: "child-write",
    skillId: "skill",
    revisionId: "revision",
    outcome: "pending" as const,
    pendingReason: "source_finalization" as const,
    replayed: false,
  };
  const publication = {
    ...deferred,
    operationId: "publication",
    sourceOperationId: "child-write",
    activationEventId: "event",
    outcome: "applied" as const,
  };
  expect(skillInstallationMessage([deferred], undefined)).toContain("waiting for installation");
  expect(skillInstallationMessage([deferred], undefined, [publication])).toBeUndefined();
  expect(
    skillInstallationMessage([deferred], undefined, [
      { ...publication, outcome: "pending", pendingReason: "approval", activationEventId: null },
    ]),
  ).toBe("1 Skill change is awaiting approval.");
  expect(
    skillInstallationMessage([deferred], undefined, [
      { ...publication, outcome: "preserved", activationEventId: null },
    ]),
  ).toBe("Your customized Skill was preserved.");
});
