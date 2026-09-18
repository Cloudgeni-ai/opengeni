import { expect, test } from "bun:test";
import {
  RigActiveVersionChangedError,
  RigChangeAlreadyVerifyingError,
  RigChangeTransitionError,
  RigImageOverrideUnsupportedError,
} from "../src";

test("Sandbox Environment errors retain their machine identity without old product copy", () => {
  const errors = [
    new RigActiveVersionChangedError("environment-id", "expected", "actual"),
    new RigChangeAlreadyVerifyingError("change-id"),
    new RigChangeTransitionError("change-id", "merged", "verifying"),
    new RigImageOverrideUnsupportedError(),
  ];
  for (const error of errors) {
    expect(error.name).toMatch(/^Rig/);
    expect(error.message.toLowerCase()).toContain("sandbox environment");
    expect(error.message).not.toMatch(/\brigs?\b/i);
  }
  expect(errors[0]).toMatchObject({
    rigId: "environment-id",
    expectedVersionId: "expected",
    actualVersionId: "actual",
  });
  expect(errors[2]).toMatchObject({
    changeId: "change-id",
    fromStatus: "merged",
    toStatus: "verifying",
  });
});
