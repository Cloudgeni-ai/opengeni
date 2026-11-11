import { expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { isKnowledgeLearningScopeGuardError } from "../src/knowledge-learning-errors";

test("only the exact nested scope guard is classified, not other permission refusals", () => {
  const driver = Object.assign(new Error("Learning scope changed after acceptance"), {
    code: "42501",
  });
  expect(
    isKnowledgeLearningScopeGuardError(new DrizzleQueryError("select private", [], driver)),
  ).toBe(true);
  expect(isKnowledgeLearningScopeGuardError(new Error(driver.message))).toBe(false);
  expect(
    isKnowledgeLearningScopeGuardError(
      Object.assign(new Error("permission denied"), { code: "42501" }),
    ),
  ).toBe(false);
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  expect(isKnowledgeLearningScopeGuardError(cycle)).toBe(false);
});
