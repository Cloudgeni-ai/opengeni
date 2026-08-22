import { describe, expect, test } from "bun:test";
import { workspaceMembershipPermissionsAllowSlackLink } from "../src";

describe("Slack identity-link membership authorization", () => {
  test("non-array persisted permission values fail closed", () => {
    expect(workspaceMembershipPermissionsAllowSlackLink("workspace:admin")).toBe(false);
    expect(workspaceMembershipPermissionsAllowSlackLink({ includes: () => true })).toBe(false);
  });

  test("mixed arrays authorize only through recognized current permissions", () => {
    expect(
      workspaceMembershipPermissionsAllowSlackLink([
        "capabilities:write",
        42,
        "sessions:create",
        "workspace:administer",
      ]),
    ).toBe(true);
    expect(
      workspaceMembershipPermissionsAllowSlackLink([
        "capabilities:write",
        42,
        "workspace:administer",
      ]),
    ).toBe(false);
  });
});
