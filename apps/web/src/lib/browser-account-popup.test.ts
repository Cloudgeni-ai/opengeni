import { describe, expect, test } from "bun:test";

import {
  accountAuthPopupMessage,
  accountAuthPopupPath,
  postAccountAuthPopupMessage,
} from "./browser-account-popup";

const TRANSACTION = "00000000-0000-4000-8000-000000000001";

describe("browser account popup protocol", () => {
  test("builds a bounded same-origin route from a UUID only", () => {
    expect(accountAuthPopupPath(TRANSACTION)).toBe(`/account-auth?transaction=${TRANSACTION}`);
    expect(() => accountAuthPopupPath("../../provider-token")).toThrow("valid browser login");
  });

  test("accepts only the exact source, origin, transaction, and secret-free shape", () => {
    const popup = {} as Window;
    const expected = {
      origin: "https://app.example.test",
      popup,
      transactionId: TRANSACTION,
    };
    const valid = {
      data: { type: "opengeni-account-auth-complete" as const, transactionId: TRANSACTION },
      origin: expected.origin,
      source: popup,
    };
    expect(accountAuthPopupMessage(valid, expected)).toEqual(valid.data);
    expect(accountAuthPopupMessage({ ...valid, origin: "https://evil.test" }, expected)).toBeNull();
    expect(accountAuthPopupMessage({ ...valid, source: {} as Window }, expected)).toBeNull();
    expect(
      accountAuthPopupMessage(
        { ...valid, data: { ...valid.data, token: "provider-secret" } },
        expected,
      ),
    ).toBeNull();
  });

  test("posts only the caller-supplied non-secret receipt to the exact origin", () => {
    const calls: unknown[][] = [];
    const opener = {
      postMessage: (...args: unknown[]) => calls.push(args),
    } as unknown as Window;
    const message = {
      type: "opengeni-account-auth-cancel" as const,
      transactionId: TRANSACTION,
    };
    expect(postAccountAuthPopupMessage(opener, "https://app.example.test", message)).toBe(true);
    expect(calls).toEqual([[message, "https://app.example.test"]]);
  });
});
