import { describe, expect, test } from "bun:test";
import {
  BrowserAuthCredentialError,
  resolveProtectedAuthFieldValues,
  totpCode,
} from "../src/browser-auth-broker";

const authority = {
  id: "password",
  kind: "connection_fields" as const,
  label: "Password",
  credential: {
    connectionId: "11111111-1111-4111-8111-111111111111",
    connectionSubjectId: null,
    providerDomain: "example.test",
  },
  fields: [
    { id: "username", purpose: "identifier" as const, credentialKey: "username" },
    {
      id: "otp",
      purpose: "totp" as const,
      credentialKey: "totp",
      digits: 8,
      periodSeconds: 30,
      algorithm: "sha1" as const,
    },
  ],
};

describe("browser auth broker", () => {
  test("resolves only configured fields and computes RFC 6238 TOTP", () => {
    const fields = resolveProtectedAuthFieldValues({
      authority,
      requestedFields: [
        { fieldId: "username", locator: { kind: "css", selector: "#user" } },
        { fieldId: "otp", locator: { kind: "css", selector: "#otp" } },
      ],
      credential: {
        username: "alice",
        totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      },
      nowMs: 59_000,
    });
    expect(fields).toEqual([
      {
        fieldId: "username",
        locator: { kind: "css", selector: "#user" },
        purpose: "identifier",
        value: "alice",
      },
      {
        fieldId: "otp",
        locator: { kind: "css", selector: "#otp" },
        purpose: "totp",
        value: "94287082",
      },
    ]);
    expect(totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", { digits: 8, nowMs: 59_000 })).toBe(
      "94287082",
    );
  });

  test("honors otpauth parameters unless the authority overrides them", () => {
    expect(
      totpCode(
        "otpauth://totp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=30&algorithm=SHA1",
        { nowMs: 59_000 },
      ),
    ).toBe("94287082");
  });

  test("fails closed for absent fields and malformed secrets", () => {
    expect(() =>
      resolveProtectedAuthFieldValues({
        authority,
        requestedFields: [{ fieldId: "password", locator: { kind: "css", selector: "#pw" } }],
        credential: {},
      }),
    ).toThrow(BrowserAuthCredentialError);
    expect(() => totpCode("not-base32!", { nowMs: 0 })).toThrow(BrowserAuthCredentialError);
  });
});
