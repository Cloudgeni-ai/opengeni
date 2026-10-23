import { expect, test } from "bun:test";
import {
  errorDiagnostic,
  markFailurePhase,
  parseErrorDiagnostic,
  redactDiagnostic,
} from "./diagnostics";
import { ProviderError } from "./github";
import { AtomicGitWriter } from "./git";
import { GitHubActiveExecutor } from "./active";
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
test("unsafe declaration tightens a benign record and multiline env secrets are redacted", () => {
  const d = { ...errorDiagnostic(new Error("benign"), {}), category: "unsafe_controller_failure" };
  expect(parseErrorDiagnostic(JSON.stringify(d), {})?.category).toBe("unsafe_controller_failure");
  const line = "short-secret-part-12345";
  expect(
    redactDiagnostic(`failure ${line}`, { PRIVATE_KEY: `header\n${line}\nfooter` }),
  ).not.toContain(line);
});
test("headers api keys cookies and cut PEM body lines are removed", () => {
  for (const raw of [
    "Authorization: token opaque-value",
    "X-Api-Key: opaque-value",
    "Cookie: opaque-value",
    "api_key=opaque-value",
    "cookie=opaque-value",
  ])
    expect(redactDiagnostic(raw, {})).not.toContain("opaque-value");
  expect(redactDiagnostic("A".repeat(64), {})).not.toContain("A".repeat(64));
});
test("every field cut and redaction expansion marks truncation", () => {
  for (const field of ["name", "operation", "phase"]) {
    const e = new Error("short");
    if (field === "phase") markFailurePhase(e, "a".repeat(400));
    else Object.assign(e, { [field]: "a".repeat(400) });
    expect(errorDiagnostic(e, {}).diagnosticTruncated).toBe(true);
  }
  expect(
    errorDiagnostic(new Error("abc ".repeat(500)), { TOKEN: "abc " }).diagnosticTruncated,
  ).toBe(true);
});
test("real atomic writer preserves original unsafe failure when verification also fails", async () => {
  const original = new Error("push transport lost");
  let reads = 0;
  const ref = "refs/heads/batcher-state";
  const git: any = {
    ancestor: async () => true,
    remoteRefs: async () => {
      if (++reads > 1) throw new Error("verification transport lost");
      return new Map([[ref, "a".repeat(40)]]);
    },
    exec: async () => {
      throw original;
    },
  };
  const writer = new AtomicGitWriter(git, "origin", ref, "refs/heads/main");
  const executor = new GitHubActiveExecutor(
    { mode: "active", stateRef: ref, baseBranch: "main", branchPrefix: "queue/live/" } as any,
    git,
    writer,
    {} as any,
    {} as any,
    "test",
  );
  const error = await (executor as any)
    .push([{ ref, expected: "a".repeat(40), next: "b".repeat(40) }])
    .catch((e: unknown) => e);
  expect(error).toBe(original);
  markFailurePhase(error, "controller-step");
  expect(errorDiagnostic(error, {}).phase).toBe("atomic-push");
  expect(errorDiagnostic(error, {}).category).toBe("unsafe_controller_failure");
});
