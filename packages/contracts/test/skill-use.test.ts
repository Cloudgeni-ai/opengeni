import { expect, test } from "bun:test";
import { SKILL_USE_META_KEY, SkillUse, skillUseFromToolOutput } from "../src";

const use = {
  id: "builtin:opengeni-documents",
  source: "builtin",
  contentSha256: "0".repeat(64),
  kind: "full",
  bytes: 1_234,
  inIndex: true,
  searchedThisTurn: false,
} as const;

test("a Skill use is a closed, content-free shape", () => {
  expect(SkillUse.parse(use)).toEqual(use);
  expect(
    SkillUse.parse({ ...use, source: "personal", contentSha256: undefined, revisionId: "r-1" }),
  ).toMatchObject({ source: "personal", revisionId: "r-1" });
  for (const invalid of [
    { ...use, content: "SKILL.md body" },
    { ...use, title: "Quarterly close" },
    { ...use, revisionId: "r-1" },
    { ...use, kind: "refused" },
    { ...use, source: "user" },
    { ...use, bytes: -1 },
    { ...use, contentSha256: "not-a-digest" },
  ]) {
    expect(SkillUse.safeParse(invalid).success).toBe(false);
  }
});

test("reads the fact from a tool result or its event projection", () => {
  const output = {
    content: [{ type: "text", text: "{}" }],
    structuredContent: {},
    _meta: { [SKILL_USE_META_KEY]: use, other: true },
  };
  expect(skillUseFromToolOutput(output)).toEqual(use);
  for (const absent of [
    null,
    "text",
    [output],
    { content: [] },
    { _meta: [] },
    { _meta: { [SKILL_USE_META_KEY]: { ...use, bytes: "big" } } },
  ]) {
    expect(skillUseFromToolOutput(absent)).toBeNull();
  }
});
