import { expect, test } from "bun:test";
import { SandboxArchiveError } from "@openai/agents/sandbox";
import { sandboxLeaseTelemetryKey } from "@opengeni/observability";
import { warnDrainSnapshotFailure } from "../src/sandbox-snapshot-diagnostics";

const lease = { workspaceId: "private-workspace", sandboxGroupId: "private-group", leaseEpoch: 3 };

test("drain diagnostics retain safe provider classification and opaque correlation only", () => {
  const calls: unknown[] = [];
  const error = Object.assign(new Error("private provider payload"), {
    name: "SandboxProviderError",
    code: "provider_error",
    retryable: true,
    details: { errorName: "ClientError", errorCode: 4, requestId: "private-request" },
  });
  warnDrainSnapshotFailure(
    {
      warn: (message, fields) => {
        calls.push({ message, fields });
      },
    },
    "capture failed",
    error,
    lease,
  );
  expect(calls).toEqual([
    {
      message: "capture failed",
      fields: {
        errorClass: "SnapshotOperationError",
        errorCode: "snapshot_operation_failed",
        origin: "worker-lifecycle",
        causeName: "SandboxProviderError",
        integrityCode: "provider_error",
        providerErrorName: "ClientError",
        providerGrpcCode: 4,
        providerRetryable: true,
        sandboxLeaseKey: sandboxLeaseTelemetryKey(lease.workspaceId, lease.sandboxGroupId),
        leaseEpoch: 3,
      },
    },
  ]);
  expect(JSON.stringify(calls)).not.toContain("private-");
  expect(JSON.stringify(calls)).not.toContain("private provider");
});

test("failed diagnostic sinks cannot change drain failure handling", () => {
  expect(() =>
    warnDrainSnapshotFailure(
      {
        warn: () => {
          throw Error("sink unavailable");
        },
      },
      "capture failed",
      Error("capture failure"),
      lease,
    ),
  ).not.toThrow();
});

test("drain diagnostics distinguish our capture deadline from wrapped provider timeout", () => {
  const calls: any[] = [];
  const logger = {
    warn: (_message: string, fields?: Record<string, unknown>) => {
      calls.push(fields);
    },
  };
  warnDrainSnapshotFailure(
    logger,
    "deadline",
    { name: "SandboxProviderCaptureTimeoutError" },
    lease,
  );
  warnDrainSnapshotFailure(
    logger,
    "late failure",
    { name: "SandboxProviderError", details: { errorName: "TimeoutError" } },
    lease,
  );
  expect(calls[0].causeName).toBe("SandboxProviderCaptureTimeoutError");
  expect(calls[0].providerErrorName).toBeUndefined();
  expect(calls[1].causeName).toBe("SandboxProviderError");
  expect(calls[1].providerErrorName).toBe("TimeoutError");
});

test("archive refusals log a closed reason class, never the member path", () => {
  const calls: any[] = [];
  const logger = {
    warn: (_message: string, fields?: Record<string, unknown>) => {
      calls.push(fields);
    },
  };
  const refusals = [
    ["hardlink member not allowed", "hardlink_member"],
    ["duplicate archive path: private/member/path", "duplicate_member"],
    ["archive member overlaps protected path: private/member", "protected_path_overlap"],
    ["invalid PAX record length", "invalid_tar_header"],
    ["a reason nobody has seen yet", "other_archive_check"],
  ] as const;
  for (const [reason] of refusals)
    warnDrainSnapshotFailure(
      logger,
      "refused",
      new SandboxArchiveError(`Unsafe tar member "private/member/path": ${reason}`, {
        member: "private/member/path",
        reason,
      }),
      lease,
    );
  warnDrainSnapshotFailure(
    logger,
    "tar failed",
    new SandboxArchiveError("tar failed", {
      provider: "ModalSandboxClient",
      root: "/private-root",
      exitCode: 2,
      stderr: "tar: private/member/path: Cannot open",
    }),
    lease,
  );
  refusals.forEach(([, expected], index) => {
    expect(calls[index]).toMatchObject({
      causeName: "SandboxArchiveError",
      integrityCode: "archive_error",
      archiveReason: expected,
    });
  });
  expect(calls[refusals.length]).toMatchObject({
    causeName: "SandboxArchiveError",
    archiveReason: "tar_exit_nonzero",
    archiveExitCode: 2,
  });
  expect(JSON.stringify(calls)).not.toContain("private");
});
