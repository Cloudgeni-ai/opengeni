import { expect, test } from "bun:test";
import { findConnectRecoveryAccount } from "../src/recovery";
import type { ConnectAccount } from "../src/types";
const account = (id: string): ConnectAccount => ({
  id,
  providerId: "same-provider",
  label: "Same name",
  ownership: "personal",
  status: "auth_needed",
  version: 2,
});
test("recovery never substitutes a same-provider account or chooses without an ID", () => {
  const accounts = [account("a"), account("b")];
  expect(findConnectRecoveryAccount(accounts, "b")?.id).toBe("b");
  expect(findConnectRecoveryAccount(accounts, "missing")).toBeNull();
  expect(findConnectRecoveryAccount(accounts, null)).toBeNull();
  expect(findConnectRecoveryAccount([account("social:a")], "a")?.id).toBe("social:a");
  expect(() => findConnectRecoveryAccount([account("a"), account("social:a")], "a")).toThrow(
    "ambiguous",
  );
});
