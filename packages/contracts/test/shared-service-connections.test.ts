import { describe, expect, test } from "bun:test";
import {
  credentialHeaderReferences,
  credentialHeadersHaveSecretReferences,
  isVaultCredentialConnection,
  VAULT_CREDENTIAL_SOURCE,
} from "../src";

const TEAM = "{{secret:Team/Example key}}";
const ORG = "{{secret:Org/Other key/token}}";

describe("shared service connection headers", () => {
  test("find the references a shared key names, once each", () => {
    const headers = { Authorization: `Bearer ${TEAM}`, "X-Other": ORG, "X-Again": TEAM };
    expect(credentialHeadersHaveSecretReferences(headers)).toBe(true);
    expect(credentialHeaderReferences(headers)).toEqual([TEAM, ORG]);
    expect(credentialHeadersHaveSecretReferences({ Authorization: "Bearer literal" })).toBe(false);
    expect(credentialHeaderReferences({ Authorization: "Bearer literal" })).toEqual([]);
  });

  test("a malformed reference is refused, not stored half-parsed", () => {
    expect(() => credentialHeaderReferences({ Authorization: "Bearer {{secret:}}" })).toThrow(
      "malformed",
    );
  });

  test("the metadata marker", () => {
    expect(isVaultCredentialConnection({ credentialSource: VAULT_CREDENTIAL_SOURCE })).toBe(true);
    expect(isVaultCredentialConnection({})).toBe(false);
    expect(isVaultCredentialConnection(null)).toBe(false);
  });
});
