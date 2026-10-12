import { describe, expect, test } from "bun:test";

import { VaultProviderError } from "../src/contract";
import { classifyOnePasswordMessage, mapOnePasswordError, onePasswordRetryAfterMs } from "../src/errors";
import { AuthExpiredError, RateLimitExceededError } from "./fake-sdk";

// Messages as produced by @1password/sdk-core 0.5.0 (read from core_bg.wasm) and
// the 429 wording documented for service accounts.
const TABLE: Array<[string, VaultProviderError["code"]]> = [
  ["rate limit exceeded", "provider_rate_limited"],
  ["Too Many Requests", "provider_rate_limited"],
  [
    "invalid service account token, please make sure you provide a valid service account token as parameter:  service account",
    "provider_auth_invalid",
  ],
  ["service account token had invalid format, please create another token: x", "provider_auth_invalid"],
  ["service account token base64 decoding failed, please create another token", "provider_auth_invalid"],
  ["service account deserialization failed, please create another token", "provider_auth_invalid"],
  ["bad service account token, please rotate it: revoked", "provider_auth_invalid"],
  ["service account token's throttle token is invalid. please create a new service account token: x", "provider_auth_invalid"],
  ["prefix 'ops_' was expected but not found", "provider_auth_invalid"],
  ["account couldn't be found", "provider_auth_invalid"],
  ["failed to authenticate", "provider_auth_invalid"],
  ["you are not authenticated", "provider_auth_expired"],
  ["session expired", "provider_auth_expired"],
  ["error updating item: incorrect item version", "provider_conflict"],
  ["a conflict occurred on the server. this usually happens due to a race condition in requests", "provider_conflict"],
  ["data conflict occurred on the server: x", "provider_conflict"],
  ["you don't have the right permissions to access this resource", "provider_permission_denied"],
  ["you don't have the right permissions to execute this request", "provider_permission_denied"],
  [
    // Observed live on the FAMILY fixture when updating "Test Login" in the read-only vault.
    "you do not have the right permissions to perform this action: not sufficient permissions for the item update operation",
    "provider_permission_denied",
  ],
  ["itemStatusPermissionError", "provider_permission_denied"],
  ["error resolving item: resource not found", "provider_not_found"],
  ["itemNotFound", "provider_not_found"],
  ["document not found in item", "provider_not_found"],
  ["file uuid not found", "provider_not_found"],
  ["request timeout", "provider_unavailable"],
  ["server error", "provider_unavailable"],
  ["validation error", "provider_unavailable"],
  ["", "provider_unavailable"],
  ["something nobody anticipated", "provider_unavailable"],
];

describe("1Password error mapping", () => {
  test.each(TABLE)("%p → %p", (message, code) => {
    expect(classifyOnePasswordMessage(message)).toBe(code);
    expect(mapOnePasswordError(new Error(message)).code).toBe(code);
  });

  test("typed SDK errors win over message text", () => {
    const limited = mapOnePasswordError(
      new RateLimitExceededError("rate limit exceeded for this 1Password account, retry in 7 minutes"),
      { RateLimitExceededError },
    );
    expect(limited.code).toBe("provider_rate_limited");
    expect(limited.retryAfterMs).toBe(7 * 60_000);
    const expired = mapOnePasswordError(new AuthExpiredError("token expired"), { AuthExpiredError });
    expect(expired.code).toBe("provider_auth_expired");
  });

  test("typed errors are recognised by class name without the loaded classes", () => {
    expect(mapOnePasswordError(new RateLimitExceededError("x")).code).toBe("provider_rate_limited");
    expect(mapOnePasswordError(new AuthExpiredError("x")).code).toBe("provider_auth_expired");
  });

  test("retry-after parsing and scope defaults", () => {
    expect(onePasswordRetryAfterMs("retry in 30 seconds")).toBe(30_000);
    expect(onePasswordRetryAfterMs("Retry in 2 hours")).toBe(2 * 3_600_000);
    expect(onePasswordRetryAfterMs("limit for this 1Password account reached")).toBe(6 * 3_600_000);
    expect(onePasswordRetryAfterMs("limit for this service account reached")).toBe(3_600_000);
    expect(onePasswordRetryAfterMs("rate limit exceeded")).toBe(15 * 60_000);
  });

  test("provider errors pass through unchanged", () => {
    const original = new VaultProviderError("provider_conflict", "x");
    expect(mapOnePasswordError(original)).toBe(original);
  });
});
