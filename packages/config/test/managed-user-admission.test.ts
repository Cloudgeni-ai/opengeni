import { expect, test } from "bun:test";
import { getSettings, managedUserEmailAllowed } from "../src";

test("parses and normalizes an explicit email allowlist", () => {
  expect(
    getSettings({ OPENGENI_ALLOWED_USER_EMAILS: " Alice@example.com, bob@example.com " })
      .allowedUserEmails,
  ).toEqual(["alice@example.com", "bob@example.com"]);
  expect(getSettings({}).allowedUserEmails).toBeUndefined();
});
test("an explicitly empty or malformed allowlist fails closed", () => {
  for (const value of ["", " ", "*", "example.com", "alice@example.com,"]) {
    expect(() => getSettings({ OPENGENI_ALLOWED_USER_EMAILS: value })).toThrow();
  }
});
test("matches exact addresses, without domain or substring matches", () => {
  expect(managedUserEmailAllowed(undefined, "any@example.com")).toBe(true);
  expect(managedUserEmailAllowed(["alice@example.com"], "ALICE@example.com")).toBe(true);
  expect(managedUserEmailAllowed(["alice@example.com"], "alice+other@example.com")).toBe(false);
  expect(managedUserEmailAllowed(["alice@example.com"], "alice@example.com.evil.test")).toBe(false);
});
