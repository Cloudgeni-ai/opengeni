import { describe, expect, test } from "bun:test";

import { accountToReturnTo, type StoredAccount } from "../src/main/accounts";

const account = (id: string, signedOut = false): StoredAccount => ({
  id,
  baseUrl: "https://app.opengeni.ai",
  subjectId: `user:${id}`,
  email: `${id}@example.com`,
  workspaceId: null,
  ...(signedOut ? { signedOut: true } : {}),
});

describe("Cancel on the sign-in page", () => {
  const accounts = [account("first"), account("picked", true), account("came-from")];

  test("returns to the account the person came from, not the first signed-in one", () => {
    const state = { accounts, activeId: "picked" };
    expect(accountToReturnTo(state, "came-from")?.id).toBe("came-from");
  });

  test("falls back to a signed-in account when the one they came from can't be used", () => {
    expect(accountToReturnTo({ accounts, activeId: "picked" }, "picked")?.id).toBe("first");
    expect(accountToReturnTo({ accounts, activeId: "picked" }, "gone")?.id).toBe("first");
    expect(accountToReturnTo({ accounts, activeId: "picked" }, null)?.id).toBe("first");
    expect(accountToReturnTo({ accounts: [account("picked", true)], activeId: null }, null)).toBe(
      null,
    );
  });
});
