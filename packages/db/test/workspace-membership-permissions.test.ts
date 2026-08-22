import { describe, expect, test } from "bun:test";
import { normalizeWorkspaceMembershipPermissions } from "../src";

describe("workspace membership permission projection", () => {
  test("non-array persisted values deny every permission", () => {
    expect(normalizeWorkspaceMembershipPermissions("workspace:admin")).toEqual([]);
    expect(normalizeWorkspaceMembershipPermissions({ includes: () => true })).toEqual([]);
    expect(normalizeWorkspaceMembershipPermissions(null)).toEqual([]);
  });

  test("mixed arrays retain only recognized permissions in stored order", () => {
    expect(
      normalizeWorkspaceMembershipPermissions([
        "workspace:read",
        "capabilities:read",
        42,
        "sessions:create",
        "workspace:administer",
      ]),
    ).toEqual(["workspace:read", "sessions:create"]);
  });
});
