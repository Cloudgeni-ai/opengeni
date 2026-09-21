import { expect, test } from "bun:test";
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
