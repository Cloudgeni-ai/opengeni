import { expect, test } from "bun:test";
import { RoutingSandboxSession, SandboxMaterializationVerificationError } from "@opengeni/runtime";
import { agentRunFailurePayload, safeErrorDiagnostic } from "../src/activities/agent-turn/errors";

test("keeps exact verification evidence in the durable failure, outside public logs", () => {
  const diagnostic = {
    reason: "command_failed" as const,
    path: "repos/private-project",
    workdir: "/workspace",
    command: "test -e 'repos/private-project'",
    output: "Process exited with code 127\nOutput:\nexact provider detail\n",
    exitCode: 127,
    providerSessionId: null,
  };
  const error = new SandboxMaterializationVerificationError(diagnostic);
  expect(agentRunFailurePayload(error)).toEqual({
    error: error.message,
    code: "sandbox_materialization_verification_failed",
    retryable: false,
    materializationDiagnostic: diagnostic,
  });
  const publicDiagnostic = JSON.stringify(safeErrorDiagnostic(error));
  expect(publicDiagnostic).not.toContain("private-project");
  expect(publicDiagnostic).not.toContain("exact provider detail");
});

test("verification diagnostics preserve existing provider retry classification", async () => {
  const cause = Object.assign(new Error("Service unavailable"), { status: 503 });
  const expected = agentRunFailurePayload(cause);
  const proxy = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => ({
      sandboxId: null,
      kind: "modal",
      session: {
        async materializeEntry() {},
        async execCommand() {
          throw cause;
        },
      },
    }),
  });
  await expect(proxy.materializeEntry({ path: "repos/example", entry: {} })).rejects.toBe(cause);
  const actual = agentRunFailurePayload(cause);
  expect(actual).toMatchObject(expected);
  expect(actual.retryable).toBe(true);
  expect(actual.materializationDiagnostic).toMatchObject({
    reason: "command_error",
    causeMessage: cause.message,
  });
});
