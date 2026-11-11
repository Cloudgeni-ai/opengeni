import { expect, test } from "bun:test";

import { personSubjectOf } from "./person-subject";

test("finds the person behind Site Data owners and rig attributions", () => {
  // A Site Data owner and Site viewer id: `user:` followed by the subject.
  expect(personSubjectOf("user:user:4f0c2a9e")).toBe("user:4f0c2a9e");
  // A subject stored as is.
  expect(personSubjectOf("user:4f0c2a9e")).toBe("user:4f0c2a9e");
  for (const other of [
    "guest:visitor-1",
    "agent:session:1",
    "schedule:task-1",
    "user:service:key-1",
    "user:",
    "user:user:",
    null,
  ])
    expect(personSubjectOf(other)).toBeNull();
});
