import { expect, test } from "bun:test";
import { ConnectionAccountSelectionDiagnostic } from "../src/index";

test("admission diagnostics accept only typed non-secret evidence", () => {
  const value: ConnectionAccountSelectionDiagnostic = {
    version: 1,
    reason: "selected_account_unavailable",
    accounts: [
      { serverId: "example", connectionId: crypto.randomUUID(), reason: "account_not_visible" },
    ],
  };
  expect(ConnectionAccountSelectionDiagnostic.parse(value)).toEqual(value);
  for (const forbidden of ["token", "headers", "message", "credential"]) {
    expect(
      ConnectionAccountSelectionDiagnostic.safeParse({ ...value, [forbidden]: "synthetic-secret" })
        .success,
    ).toBe(false);
    expect(
      ConnectionAccountSelectionDiagnostic.safeParse({
        ...value,
        accounts: [{ ...value.accounts[0], [forbidden]: "synthetic-secret" }],
      }).success,
    ).toBe(false);
  }
  expect(
    ConnectionAccountSelectionDiagnostic.safeParse({
      ...value,
      reason: "provider says synthetic-secret",
    }).success,
  ).toBe(false);
});
