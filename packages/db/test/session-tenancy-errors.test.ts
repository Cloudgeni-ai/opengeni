import { describe, expect, test } from "bun:test";
import { nestedSessionTenancyBlocker } from "../src/session-tenancy";

describe("session tenancy persistence diagnostics", () => {
  test("extracts only the fixed quiescence DETAIL vocabulary through driver wrappers", () => {
    expect(
      nestedSessionTenancyBlocker({ cause: { driverError: { detail: "shared_sandbox_group" } } }),
    ).toBe("shared_sandbox_group");
    expect(nestedSessionTenancyBlocker({ detail: "select secret from credentials" })).toBeNull();
    expect(nestedSessionTenancyBlocker({ detailMessage: "active_goal" })).toBe("active_goal");
  });
});
