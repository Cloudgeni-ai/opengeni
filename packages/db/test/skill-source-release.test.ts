import { describe, expect, test } from "bun:test";
import {
  classifySkillSourceRelease,
  type SkillSourceReleaseHead,
} from "../src/skill-source-release-impact";

const head: SkillSourceReleaseHead = {
  id: "skill",
  account_id: "account",
  scope: "workspace",
  scope_workspace_id: "workspace",
  scope_version: 1,
  status: "active",
  active_revision_id: "revision",
  provenance_source: "portable_skill",
  title: "Source Skill",
};

describe("shared source-release classifier", () => {
  test("untouched source Skill is removed from active registry, not erased", () => {
    expect(classifySkillSourceRelease(head, "workspace")).toEqual({
      disposition: "removed",
      retentionReasons: [],
    });
  });
  test.each(["human", "agent", null])("preserves customized provenance %s", (provenance_source) => {
    expect(classifySkillSourceRelease({ ...head, provenance_source }, "workspace")).toEqual({
      disposition: "retained",
      retentionReasons: ["customized"],
    });
  });
  test.each(["organization", "user"])("preserves re-scoped %s Skill", (scope) => {
    expect(
      classifySkillSourceRelease({ ...head, scope, scope_workspace_id: null }, "workspace"),
    ).toEqual({ disposition: "retained", retentionReasons: ["re_scoped"] });
  });
  test("preserves a Skill moved to another workspace and reports both reasons", () => {
    expect(
      classifySkillSourceRelease(
        { ...head, scope_workspace_id: "other", provenance_source: "human" },
        "workspace",
      ),
    ).toEqual({ disposition: "retained", retentionReasons: ["customized", "re_scoped"] });
  });
  test("already inactive heads do not claim removal or customization retention", () => {
    expect(
      classifySkillSourceRelease(
        { ...head, status: "inactive", provenance_source: "human" },
        "workspace",
      ),
    ).toEqual({ disposition: "inactive", retentionReasons: [] });
    expect(
      classifySkillSourceRelease({ ...head, active_revision_id: null }, "workspace").disposition,
    ).toBe("inactive");
  });
});
