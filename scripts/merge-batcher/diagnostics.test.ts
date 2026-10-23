import { expect, test } from "bun:test";
import {
  errorDiagnostic,
  markFailurePhase,
  parseErrorDiagnostic,
  redactDiagnostic,
} from "./diagnostics";
import { ProviderError } from "./github";
test("active errors retain bounded message stack phase operation and status", () => {
  const e = markFailurePhase(new ProviderError(503, "ready timeline"), "controller-step");
  const d = errorDiagnostic(e, {});
  expect(d.httpStatus).toBe(503);
  expect(d.operation).toBe("ready timeline");
  expect(d.phase).toBe("controller-step");
  expect(d.message).toContain("503");
  expect(d.stack).toContain("diagnostics.test.ts");
  expect(parseErrorDiagnostic(JSON.stringify(d), {})).toEqual(d);
});
test("credential redaction preserves useful text but not tokens keys URLs or authorization", () => {
  const secret = "secret-fixture-value-1234";
  const raw = `failure ${secret} Bearer dynamic-credential ghp_dynamicTOKEN https://user:pass@example.test/?token=secret password=abc123\n-----BEGIN PRIVATE KEY-----\nbase64key\n-----END PRIVATE KEY-----\nuseful phase`;
  const d = redactDiagnostic(raw, { GITHUB_TOKEN: secret });
  for (const value of [
    secret,
    "dynamic-credential",
    "ghp_dynamicTOKEN",
    "user:pass",
    "abc123",
    "base64key",
  ])
    expect(d).not.toContain(value);
  expect(d).toContain("useful phase");
});
test("flooded and malformed diagnostics remain bounded with safe fallback", () => {
  const e = new Error('"\n'.repeat(20000));
  e.stack = '"\n'.repeat(20000);
  expect(Buffer.byteLength(JSON.stringify(errorDiagnostic(e, {})))).toBeLessThanOrEqual(6144);
  expect(parseErrorDiagnostic("not json")).toBeNull();
});
test("unsafe write phase survives outer controller annotation", () => {
  const e = markFailurePhase(new Error("sanitized failure"), "atomic-push");
  markFailurePhase(e, "controller-step");
  const d = errorDiagnostic(e, {});
  expect(d.phase).toBe("atomic-push");
  expect(d.category).toBe("unsafe_controller_failure");
  expect(errorDiagnostic(new Error("Stale remote ref snapshot")).category).toBe(
    "unsafe_controller_failure",
  );
  expect(errorDiagnostic(new Error("Rules drift detected")).category).toBe(
    "unsafe_controller_failure",
  );
});
