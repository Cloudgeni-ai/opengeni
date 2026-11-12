import { describe, expect, test } from "bun:test";

import {
  accountToReturnTo,
  cameFromAfterShowing,
  welcomeServer,
  type StoredAccount,
} from "../src/main/accounts";

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

  test("remembers the signed-in account left for a signed-out one, through a chain of them", () => {
    const [signedIn, picked, other] = [account("a"), account("b", true), account("c", true)];
    expect(cameFromAfterShowing(signedIn, picked, null)).toBe("a");
    // Then another signed-out account from the welcome page: still back to a.
    expect(cameFromAfterShowing(picked, other, "a")).toBe("a");
    // Reaching a signed-in account (a switch or a finished sign-in) forgets it.
    expect(cameFromAfterShowing(picked, account("d"), "a")).toBe(null);
    expect(cameFromAfterShowing(null, picked, null)).toBe(null);
  });
});

describe("the server the sign-in page signs in to", () => {
  const app = "https://app.opengeni.ai";
  const staging = (signedOut: boolean): StoredAccount => ({
    ...account("staging", signedOut),
    baseUrl: "https://staging.app.opengeni.ai",
  });

  test("signing a signed-out account in again goes to that account's own server", () => {
    // "Sign in again to staging.app.opengeni.ai" must not open the app's own server.
    expect(welcomeServer(staging(true), false, app)).toBe("https://staging.app.opengeni.ai");
  });

  test("first sign-in, adding an account and a signed-in account use the app's server", () => {
    expect(welcomeServer(null, false, app)).toBe(app);
    expect(welcomeServer(staging(true), true, app)).toBe(app);
    expect(welcomeServer(staging(false), false, app)).toBe(app);
  });
});
