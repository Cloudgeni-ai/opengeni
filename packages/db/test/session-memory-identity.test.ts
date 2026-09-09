import { expect, test } from "bun:test";
import { SessionEndUser } from "@opengeni/contracts";
import { endUserMemorySubjectId, normalizeMemoryScope } from "../src/memory-domain";

test("opaque end-user memory identities are unambiguous, exact, and bounded", () => {
  const labels = [
    { source: "app:team", id: "alice" },
    { source: "app", id: "team:alice" },
    { source: "app", id: "alice" },
    { source: "app", id: "alice " },
    { source: "app", id: "Alice" },
    { source: "a".repeat(200), id: "b".repeat(1024) },
    { source: 'a"b', id: "[c,d]" },
  ].map((value) => SessionEndUser.parse(value));
  const identities = labels.map(endUserMemorySubjectId);
  expect(new Set(identities).size).toBe(labels.length);
  for (const [index, subjectId] of identities.entries()) {
    expect(subjectId).toMatch(/^end_user:v1:[a-f0-9]{64}$/);
    expect(endUserMemorySubjectId(labels[index]!)).toBe(subjectId);
    expect(normalizeMemoryScope({ type: "user", subjectId })).toEqual({ type: "user", subjectId });
  }
});
