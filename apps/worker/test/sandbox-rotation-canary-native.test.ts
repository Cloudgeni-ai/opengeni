import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import type { RoutingSandboxSession } from "@opengeni/runtime";
import {
  requiredCommandSupervisionProtocol,
  turnCommandSupervisionProtocol,
} from "../../../packages/runtime/src/sandbox/provider-command-session";
import {
  assertNativeCanaryCompletion,
  assertNativeCanarySettlement,
  desktopCanaryConfiguration,
  nativeCanaryControlProgram,
  nativeCanaryTools,
  type NativeSettledProjection,
} from "./sandbox-rotation-canary-native";

const source = "a".repeat(40);
const env = {
  OPENGENI_SANDBOX_ROTATION_CANARY: "1",
  OPENGENI_SANDBOX_ROTATION_CANARY_AUTHORIZATION: "ISOLATED_MODAL_CANARY_ONLY",
  OPENGENI_SANDBOX_ROTATION_SOURCE_SHA: source,
  OPENGENI_SANDBOX_ROTATION_IMAGE_REF: `opengenipublicneuacr.azurecr.io/opengeni-desktop@sha256:${"b".repeat(64)}`,
  OPENGENI_SANDBOX_ROTATION_API_IMAGE_REF: `ghcr.io/cloudgeni-ai/opengeni-api@sha256:${"c".repeat(64)}`,
  OPENGENI_SANDBOX_ROTATION_WORKER_IMAGE_REF: `ghcr.io/cloudgeni-ai/opengeni-worker@sha256:${"d".repeat(64)}`,
  OPENGENI_SANDBOX_ROTATION_NATIVE_POSTGRES: "LOCAL_DISPOSABLE_55434",
  OPENGENI_SANDBOX_ROTATION_MODAL_ENVIRONMENT: "sandbox-rotation-canary-12345678",
  MODAL_TOKEN_ID: "test-only",
  MODAL_TOKEN_SECRET: "test-only",
};
const invocationId = "809b79db-cc2b-4b65-9fa3-89e2f4735665";
const execId = "10ee7d7d-f457-4419-89ca-a084034a0e61";
function original(pty = true): ModalRouterProviderCommand {
  return {
    kind: "modal-router-v1",
    sandboxId: "sb-native",
    taskId: "ta-native",
    execId,
    pty,
    supervision: {
      protocol: pty ? "native-subreaper-pty-v1" : "native-subreaper-v1",
      invocationId,
      nonce: "b".repeat(64),
      controlPath: `/tmp/opengeni-supervision/${invocationId}.sock`,
    },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
}
function settled(pty = true): NativeSettledProjection {
  const command = original(pty);
  for (const stream of ["stdout", "stderr"] as const)
    command.streams[stream] = { byteOffset: 100, utf8Remainder: "", eof: true, exitCode: 0 };
  return {
    providerCommand: command,
    state: "exited",
    exitCode: 137,
    settledAt: new Date(1_800),
    supervisionReceipt: {
      protocol: pty ? "native-subreaper-pty-v1" : "native-subreaper-v1",
      invocationId,
      receiptId: execId,
      leaderExitCode: 137,
    },
    supervisionOutputCaptured: true,
    cancellationRequestedAt: new Date(1_100),
    cancellationReason: "explicit_stop",
    backgroundState: null,
    backgroundCancelledAt: null,
    backgroundExitCode: null,
    remainingHolders: 0,
    remainingAdmissions: 0,
  };
}
const timing = { pty: true, requestedAt: 1_000, completedAt: 1_900, background: false };

describe("Desktop native isolated fixture gates", () => {
  test("accepts exact authoritative ACR desktop and immutable server candidates at flag false", () => {
    expect(desktopCanaryConfiguration(env).sourceSha).toBe(source);
  });
  for (const patch of [
    { OPENGENI_MODAL_COMMAND_SUPERVISION_ENABLED: "true" },
    { OPENGENI_SANDBOX_ROTATION_API_IMAGE_REF: "ghcr.io/cloudgeni-ai/opengeni-api:latest" },
    { OPENGENI_SANDBOX_ROTATION_WORKER_IMAGE_REF: env.OPENGENI_SANDBOX_ROTATION_API_IMAGE_REF },
    {
      OPENGENI_SANDBOX_ROTATION_IMAGE_REF: env.OPENGENI_SANDBOX_ROTATION_IMAGE_REF.replace(
        "opengenipublicneuacr",
        "evil",
      ),
    },
    { OPENGENI_SANDBOX_ROTATION_MODAL_ENVIRONMENT: "production" },
    { OPENGENI_TEST_POSTGRES_ADMIN_URL: "postgres://production" },
  ])
    test(`rejects ${Object.keys(patch)[0]}`, () => {
      expect(() => desktopCanaryConfiguration({ ...env, ...patch })).toThrow(
        "Sandbox rotation canary:",
      );
    });
  test("control program parses as bash and refuses a non-fixture path", () => {
    const path = `/workspace/sandbox_native_${invocationId}`;
    expect(() =>
      execFileSync("bash", ["-n"], { input: nativeCanaryControlProgram(path) }),
    ).not.toThrow();
    expect(() => nativeCanaryControlProgram("/workspace/existing-user-file")).toThrow();
  });
});

test("fixture command adapters use the actual controller's trusted pipe/PTY context", async () => {
  const calls: Array<{ tty: boolean; required: string | undefined; turn: string | undefined }> = [];
  const session = {
    execCommand: async (args: { tty: boolean }) => {
      calls.push({
        tty: args.tty,
        required: requiredCommandSupervisionProtocol(),
        turn: turnCommandSupervisionProtocol(),
      });
      return "Process exited with code 0\n\nOutput:\nfinished";
    },
    writeStdinForProcessMutation: async () => {
      throw new Error("completed fixture should not send stdin");
    },
  } as unknown as RoutingSandboxSession;
  const tools = nativeCanaryTools(session);
  await tools.exec("bash --noprofile --norc", false);
  await tools.exec("bash --noprofile --norc", true);
  await tools.exec("printf finished", false);
  expect(calls).toEqual([
    { tty: false, required: "native-subreaper-v1", turn: "native-subreaper-v1" },
    { tty: true, required: "native-subreaper-pty-v1", turn: "native-subreaper-pty-v1" },
    { tty: false, required: undefined, turn: "native-subreaper-v1" },
  ]);
  expect(turnCommandSupervisionProtocol()).toBeUndefined();
  await tools.controller.waitForQuiescence();
});

describe("Native physical cancellation proof cannot be weakened", () => {
  test("binds PTY receipt and complete captured output to the original native invocation", () => {
    const proof = assertNativeCanarySettlement(original(), settled(), timing);
    expect(proof.protocol).toBe("native-subreaper-pty-v1");
    expect(JSON.stringify(proof)).not.toContain("b".repeat(64));
    expect(JSON.stringify(proof)).not.toContain("controlPath");
  });
  const faults: Array<[string, (row: NativeSettledProjection) => void]> = [
    [
      "missing native receipt",
      (row) => {
        row.supervisionReceipt = null;
      },
    ],
    [
      "uncaptured output",
      (row) => {
        row.supervisionOutputCaptured = false;
      },
    ],
    [
      "remaining holder",
      (row) => {
        row.remainingHolders = 1;
      },
    ],
    [
      "remaining writer",
      (row) => {
        row.remainingAdmissions = 1;
      },
    ],
    [
      "provider loss",
      (row) => {
        row.state = "lost";
      },
    ],
    [
      "background adoption of bare shell",
      (row) => {
        row.backgroundState = "running";
      },
    ],
    [
      "wrong cancellation intent",
      (row) => {
        row.cancellationReason = "provider_deadline";
      },
    ],
    [
      "early receipt",
      (row) => {
        row.settledAt = new Date(900);
      },
    ],
    [
      "late receipt",
      (row) => {
        row.settledAt = new Date(2_000);
      },
    ],
    [
      "wrong physical command",
      (row) => {
        if (row.providerCommand?.kind === "modal-router-v1")
          row.providerCommand.execId = invocationId;
      },
    ],
    [
      "nonterminal output",
      (row) => {
        if (row.providerCommand?.kind === "modal-router-v1")
          row.providerCommand.streams.stderr.eof = false;
      },
    ],
    [
      "wrong invocation receipt",
      (row) => {
        if (row.supervisionReceipt) row.supervisionReceipt.invocationId = execId;
      },
    ],
  ];
  for (const [name, mutate] of faults)
    test(`rejects ${name}`, () => {
      const row = settled();
      mutate(row);
      expect(() => assertNativeCanarySettlement(original(), row, timing)).toThrow(
        "Sandbox rotation canary:",
      );
    });
  test("two seconds remains a required physical boundary", () => {
    expect(() =>
      assertNativeCanarySettlement(original(), settled(), { ...timing, completedAt: 3_001 }),
    ).toThrow("two-second fence");
  });
  test("PTY and pipe protocols cannot be substituted", () => {
    expect(() => assertNativeCanarySettlement(original(false), settled(false), timing)).toThrow();
    expect(
      assertNativeCanarySettlement(original(false), settled(false), { ...timing, pty: false })
        .protocol,
    ).toBe("native-subreaper-v1");
  });
  test("adopted stop requires the exact background owner to settle too", () => {
    const row = settled(false);
    expect(() =>
      assertNativeCanarySettlement(original(false), row, {
        ...timing,
        pty: false,
        background: true,
      }),
    ).toThrow();
    row.backgroundState = "exited";
    row.backgroundExitCode = 137;
    row.backgroundCancelledAt = new Date(1_100);
    expect(() =>
      assertNativeCanarySettlement(original(false), row, {
        ...timing,
        pty: false,
        background: true,
      }),
    ).not.toThrow();
  });
  test("ordinary core completion still requires native receipt and all router output", () => {
    const row = settled();
    row.exitCode = 0;
    row.supervisionReceipt!.leaderExitCode = 0;
    expect(assertNativeCanaryCompletion(row, true).protocol).toBe("native-subreaper-pty-v1");
    row.remainingAdmissions = 1;
    expect(() => assertNativeCanaryCompletion(row, true)).toThrow();
  });
});
