import { describe, expect, test } from "bun:test";

import { canUsePersonalInbox } from "./inbox";

describe("personal inbox browser access", () => {
  test("requires a managed session and an authenticated human session", () => {
    expect(canUsePersonalInbox("managedSession", true)).toBe(true);
    expect(canUsePersonalInbox("managedSession", false)).toBe(false);
    expect(canUsePersonalInbox("none", true)).toBe(false);
  });
});
