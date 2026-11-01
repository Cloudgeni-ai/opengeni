import { describe, expect, test } from "bun:test";
import type { ConnectionMetadata } from "@opengeni/sdk";
import { addAccountLimit } from "../src/app/components/capabilities/connection-account-rows";

type Account = Pick<ConnectionMetadata, "subjectId" | "status" | "accountIdentity">;
const personal = (subjectId: string, overrides: Partial<Account> = {}): Account => ({
  subjectId,
  status: "active",
  accountIdentity: "single",
  ...overrides,
});
const shared = (overrides: Partial<Account> = {}): Account => ({
  subjectId: null,
  status: "active",
  accountIdentity: "single",
  ...overrides,
});
const viewer = "alice";
const limit = (accounts: Account[], ownership: "personal" | "workspace") =>
  addAccountLimit(accounts, { viewerSubjectId: viewer, ownership });

describe("adding another account mirrors the server's account rule", () => {
  test("one account per person when the service can't identify accounts", () => {
    expect(limit([], "personal")).toBeNull();
    expect(limit([personal(viewer)], "personal")).toBe("single");
    expect(limit([shared()], "personal")).toBe("single");
    expect(limit([personal(viewer)], "workspace")).toBe("single");
    expect(limit([shared()], "workspace")).toBe("single");
    // Other people's personal accounts and removed accounts don't count.
    expect(limit([personal("bob")], "workspace")).toBeNull();
    expect(limit([personal("bob")], "personal")).toBeNull();
    expect(limit([shared({ status: "revoked" })], "personal")).toBeNull();
  });
  test("an account from before identity is reconnected once, in its own place", () => {
    expect(limit([personal(viewer, { accountIdentity: "reconnect" })], "personal")).toBe(
      "reconnect",
    );
    expect(limit([personal(viewer, { accountIdentity: "reconnect" })], "workspace")).toBeNull();
    expect(limit([shared({ accountIdentity: "reconnect" })], "workspace")).toBe("reconnect");
    expect(limit([personal(viewer, { accountIdentity: "verified" })], "personal")).toBeNull();
    expect(limit([personal(viewer, { accountIdentity: undefined })], "personal")).toBeNull();
  });
});
