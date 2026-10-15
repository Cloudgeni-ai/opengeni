import { describe, expect, test } from "bun:test";
import { isDefiniteMutationFailure, mapProtonFailure } from "../src/errors";
import type { ProcessResult } from "../src/runner";

function failed(stderr: string, extra: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr,
    timedOut: false,
    aborted: false,
    stdoutOverflow: false,
    spawnError: null,
    ...extra,
  };
}

const api = (context: string, reason: string) =>
  `Error: ${context}\n\nCaused by:\n    Could not perform operation. Reason: ${reason}\n`;
const status = (context: string, code: number) =>
  `Error: ${context}\n\nCaused by:\n    Invalid status code: ${code}\n`;

describe("mapProtonFailure", () => {
  const cases: Array<[string, ProcessResult, string]> = [
    [
      "NotLatestRevision",
      failed(api("Error trashing item", "NotLatestRevision")),
      "provider_conflict",
    ],
    [
      "PermissionDenied",
      failed(api("Error creating login item", "PermissionDenied")),
      "provider_permission_denied",
    ],
    [
      "InsufficientScope",
      failed(api("Error retrieving item", "InsufficientScope")),
      "provider_permission_denied",
    ],
    ["NotExists", failed(api("Error retrieving item", "NotExists")), "provider_not_found"],
    ["DeletedShare", failed(api("Error listing items", "DeletedShare")), "provider_not_found"],
    ["SessionLocked", failed(api("Error listing items", "SessionLocked")), "provider_locked"],
    ["NoQuotaLeft", failed(api("Error creating note item", "NoQuotaLeft")), "provider_unavailable"],
    ["429", failed(status("Error listing items", 429)), "provider_rate_limited"],
    ["401", failed(status("Error listing items", 401)), "provider_auth_expired"],
    ["403", failed(status("Error listing items", 403)), "provider_permission_denied"],
    ["404", failed(status("Error listing items", 404)), "provider_not_found"],
    ["503", failed(status("Error listing items", 503)), "provider_unavailable"],
    [
      "item not found",
      failed("Error: Error retrieving item\n\nCaused by:\n    Item not found\n"),
      "provider_not_found",
    ],
    ["share not found", failed("Error: Share with id abc== not found\n"), "provider_not_found"],
    [
      "invalidated",
      failed("Your session has been invalidated and you have been logged out automatically.\n"),
      "provider_auth_expired",
    ],
    [
      "no session",
      failed("Error: This operation requires an authenticated client\n"),
      "provider_auth_expired",
    ],
    [
      "network",
      failed("Error: Error listing items\n\nCaused by:\n    error sending request for url\n"),
      "provider_unavailable",
    ],
    ["timeout", failed("", { timedOut: true, exitCode: null }), "provider_unavailable"],
    ["spawn", failed("", { spawnError: "ENOENT", exitCode: null }), "provider_unavailable"],
  ];
  for (const [name, result, code] of cases) {
    test(name, () => {
      expect(mapProtonFailure(result, "list items").code).toBe(code as never);
    });
  }

  test("never repeats stderr beyond the closed Proton error code", () => {
    const error = mapProtonFailure(
      failed("Error: Error listing items\n\nCaused by:\n    secret-looking-detail pst_abc::def\n"),
      "list items",
    );
    expect(error.message).not.toContain("secret-looking-detail");
    expect(error.message).not.toContain("pst_abc");
  });
});

describe("isDefiniteMutationFailure", () => {
  const create = /Error creating login item/;
  test("a server verdict inside the create context is definite", () => {
    expect(
      isDefiniteMutationFailure(
        failed(api("Error creating login item", "PermissionDenied")),
        create,
      ),
    ).toBe(true);
  });
  test("pre-flight failures are definite", () => {
    expect(
      isDefiniteMutationFailure(failed("Error: Error parsing JSON from stdin\n"), create),
    ).toBe(true);
    expect(
      isDefiniteMutationFailure(
        failed(
          "Error: Agent sessions must set the PROTON_PASS_AGENT_REASON environment variable\n",
        ),
        create,
      ),
    ).toBe(true);
    expect(
      isDefiniteMutationFailure(
        failed(
          "Error: Error trashing item\n\nCaused by:\n    Error creating trash item request\n\nCaused by:\n    Item not found\n",
        ),
        /Error trashing item/,
      ),
    ).toBe(true);
  });
  test("errors after the request, timeouts, signals and invalidation are unknown", () => {
    expect(
      isDefiniteMutationFailure(failed(status("Error sending monitor event", 500)), create),
    ).toBe(false);
    expect(
      isDefiniteMutationFailure(
        failed("Error: Error creating login item\n\nCaused by:\n    error sending request\n"),
        create,
      ),
    ).toBe(false);
    expect(isDefiniteMutationFailure(failed("", { timedOut: true, exitCode: null }), create)).toBe(
      false,
    );
    expect(
      isDefiniteMutationFailure(failed("", { signal: "SIGKILL", exitCode: null }), create),
    ).toBe(false);
    expect(isDefiniteMutationFailure(failed("", { aborted: true, exitCode: null }), create)).toBe(
      false,
    );
    expect(isDefiniteMutationFailure(failed("Your session has been invalidated\n"), create)).toBe(
      false,
    );
  });
});
