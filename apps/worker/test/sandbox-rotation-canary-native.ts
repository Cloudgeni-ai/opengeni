import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CommandSupervisionReceipt, ModalRouterProviderCommand } from "@opengeni/contracts";
import { readImmutableServerSourceSha } from "@opengeni/config/server-source-identity";
import { createTurnToolCancellationController } from "../../../packages/runtime/src/sandbox/turn-tool-cancellation";
import type { RoutingSandboxSession } from "@opengeni/runtime";
import { parseExecResponseBanner } from "../../../packages/runtime/src/sandbox/exec-banner";
import { canaryConfiguration, requireCanary } from "./sandbox-rotation-canary-evidence";
import { verifyCanonicalCanaryImageProvenance } from "./sandbox-rotation-canary-provenance";
import type { CanarySupervisionProjection } from "./sandbox-rotation-canary-supervision";

export function desktopCanaryConfiguration(env: Record<string, string | undefined>) {
  const base = canaryConfiguration(env, "desktop");
  requireCanary(
    !env.OPENGENI_MODAL_COMMAND_SUPERVISION_ENABLED ||
      env.OPENGENI_MODAL_COMMAND_SUPERVISION_ENABLED === "false",
    "desktop cohort qualification requires the global background flag to stay false",
  );
  const apiImage = env.OPENGENI_SANDBOX_ROTATION_API_IMAGE_REF ?? "";
  const workerImage = env.OPENGENI_SANDBOX_ROTATION_WORKER_IMAGE_REF ?? "";
  for (const [name, image] of [
    ["api", apiImage],
    ["worker", workerImage],
  ] as const)
    requireCanary(
      new RegExp(`^ghcr\\.io/cloudgeni-ai/opengeni-${name}@sha256:[a-f0-9]{64}$`, "u").test(image),
      `pin the canonical immutable ${name} candidate image`,
    );
  return { ...base, apiImage, workerImage };
}

/** The host must launch precisely workerImage without source mounts. OCI labels
 * plus baked bytes establish source identity, not a signed build attestation.
 * The fixture cannot introspect its host Docker launch binding. */
export async function verifyDesktopCanarySource(
  config: ReturnType<typeof desktopCanaryConfiguration>,
  env: Record<string, string | undefined> = process.env,
) {
  requireCanary(
    process.platform === "linux" && process.arch === "x64",
    "desktop native fixture requires the verified linux/amd64 worker platform",
  );
  requireCanary(
    (await readImmutableServerSourceSha()) === config.sourceSha,
    "running worker lacks the matching image-owned immutable source SHA",
  );
  const tokens = {
    ...(env.OPENGENI_SANDBOX_ROTATION_GHCR_PULL_TOKEN
      ? { ghcr: env.OPENGENI_SANDBOX_ROTATION_GHCR_PULL_TOKEN }
      : {}),
    ...(env.OPENGENI_SANDBOX_ROTATION_ACR_PULL_TOKEN
      ? { acr: env.OPENGENI_SANDBOX_ROTATION_ACR_PULL_TOKEN }
      : {}),
  };
  const [desktop, api, worker] = await Promise.all([
    verifyCanonicalCanaryImageProvenance(config.sourceSha, config.image, "desktop", fetch, tokens),
    verifyCanonicalCanaryImageProvenance(config.sourceSha, config.apiImage, "api", fetch, tokens),
    verifyCanonicalCanaryImageProvenance(
      config.sourceSha,
      config.workerImage,
      "worker",
      fetch,
      tokens,
    ),
  ]);
  return { desktop, api, worker, bakedSourceSha: config.sourceSha };
}

type NativeTool = {
  type: "function";
  name: string;
  invoke(context: unknown, input: string): Promise<unknown>;
};

/** Actual production cancellation controller and route methods. In particular,
 * direct execCommand calls alone do not supply trusted turn protocol context. */
export function nativeCanaryTools(route: RoutingSandboxSession) {
  const controller = createTurnToolCancellationController();
  const tools = controller.wrapTools<NativeTool>(
    [
      {
        type: "function",
        name: "exec_command",
        invoke: async (_context, input) => {
          const args = JSON.parse(input) as {
            cmd: string;
            tty?: boolean;
            yield_time_ms?: number;
            max_output_tokens?: number;
          };
          return await route.execCommand({
            cmd: args.cmd,
            tty: args.tty ?? false,
            yieldTimeMs: args.yield_time_ms ?? 1_000,
            maxOutputTokens: args.max_output_tokens ?? 4_000,
          });
        },
      },
      {
        type: "function",
        name: "write_stdin",
        invoke: async (_context, input) => {
          const args = JSON.parse(input) as {
            session_id: number;
            chars?: string;
            yield_time_ms?: number;
            max_output_tokens?: number;
          };
          return await route.writeStdinForProcessMutation({
            sessionId: args.session_id,
            chars: args.chars ?? "",
            yieldTimeMs: args.yield_time_ms ?? 1_000,
            maxOutputTokens: args.max_output_tokens ?? 4_000,
          });
        },
      },
    ],
    route,
  );
  const exec = tools.find((tool) => tool.name === "exec_command")!;
  const write = tools.find((tool) => tool.name === "write_stdin")!;
  return {
    controller,
    async exec(cmd: string, tty = false): Promise<string> {
      const result = await exec.invoke(
        {},
        JSON.stringify({ cmd, tty, yield_time_ms: 1_000, max_output_tokens: 4_000 }),
      );
      requireCanary(typeof result === "string", "native tool returned no command banner");
      return result;
    },
    async input(sessionId: number, chars: string): Promise<string> {
      const result = await write.invoke(
        {},
        JSON.stringify({
          session_id: sessionId,
          chars,
          yield_time_ms: 1_000,
          max_output_tokens: 4_000,
        }),
      );
      requireCanary(typeof result === "string", "native shell input returned no receipt");
      return result;
    },
    async command(cmd: string, pty = false): Promise<string> {
      const args = { cmd, tty: pty, yieldTimeMs: 1_000, maxOutputTokens: 4_000 };
      const result = pty
        ? await controller.runSandboxCommandStructured(route, args)
        : await controller.runSandboxCommandSynchronous(route, args);
      requireCanary(result.exitCode === 0, "native routed fixture command failed");
      return result.stdout + result.stderr;
    },
  };
}

export type NativeSettledProjection = Omit<
  CanarySupervisionProjection,
  "backgroundState" | "backgroundCancelledAt" | "backgroundExitCode"
> & {
  backgroundState: string | null;
  backgroundCancelledAt: Date | null;
  backgroundExitCode: number | null;
  remainingHolders: number;
  remainingAdmissions: number;
};

export function assertNativeCanarySettlement(
  original: unknown,
  row: NativeSettledProjection | undefined,
  input: { pty: boolean; requestedAt: number; completedAt: number; background: boolean },
) {
  requireCanary(row, "native physical settlement projection is missing");
  const before = ModalRouterProviderCommand.safeParse(original);
  const after = ModalRouterProviderCommand.safeParse(row.providerCommand);
  requireCanary(before.success && after.success, "invalid native invocation projection");
  const expected = before.data;
  const current = after.data;
  const protocol = input.pty ? "native-subreaper-pty-v1" : "native-subreaper-v1";
  requireCanary(
    expected.supervision?.protocol === protocol && Boolean(expected.pty) === input.pty,
    "native invocation has the wrong PTY/protocol ownership",
  );
  requireCanary(
    current.sandboxId === expected.sandboxId &&
      current.taskId === expected.taskId &&
      current.execId === expected.execId &&
      Boolean(current.pty) === input.pty &&
      isDeepStrictEqual(current.supervision, expected.supervision),
    "native invocation changed its original physical identity",
  );
  const parsed = CommandSupervisionReceipt.safeParse(row.supervisionReceipt);
  requireCanary(
    parsed.success &&
      parsed.data.protocol === protocol &&
      parsed.data.invocationId === expected.supervision.invocationId,
    "native all-child receipt is absent or belongs to another invocation",
  );
  const receipt = parsed.data;
  for (const stream of ["stdout", "stderr"] as const) {
    const cursor = current.streams[stream];
    requireCanary(
      cursor.byteOffset >= expected.streams[stream].byteOffset &&
        cursor.eof === true &&
        cursor.exitCode === 0 &&
        cursor.utf8Remainder === "",
      "native supervisor output lacks authenticated complete EOF",
    );
  }
  const requestedAt = row.cancellationRequestedAt?.getTime() ?? NaN;
  const settledAt = row.settledAt?.getTime() ?? NaN;
  requireCanary(
    row.state === "exited" &&
      row.exitCode === receipt.leaderExitCode &&
      row.supervisionOutputCaptured &&
      row.remainingHolders === 0 &&
      row.remainingAdmissions === 0,
    "native cancellation did not physically settle its writers and output",
  );
  requireCanary(
    row.cancellationReason === "explicit_stop" &&
      requestedAt >= input.requestedAt &&
      settledAt >= requestedAt &&
      settledAt <= input.completedAt,
    "native cancellation lacks timely original-invocation intent/settlement",
  );
  requireCanary(
    input.completedAt - input.requestedAt <= 2_000,
    "native cancellation exceeded the two-second fence",
  );
  if (input.background)
    requireCanary(
      row.backgroundState === "exited" &&
        row.backgroundExitCode === receipt.leaderExitCode &&
        row.backgroundCancelledAt !== null,
      "adopted native command did not settle its background owner",
    );
  else
    requireCanary(row.backgroundState === null, "bare native shell acquired background ownership");
  return {
    protocol,
    invocationId: receipt.invocationId,
    receiptId: receipt.receiptId,
    leaderExitCode: receipt.leaderExitCode,
    providerExitCode: 0,
    outputCaptured: true,
    cancellationReason: "explicit_stop",
    requestedAt,
    settledAt,
    cancellationElapsedMs: input.completedAt - input.requestedAt,
    instanceId: current.sandboxId,
    taskId: current.taskId,
    execId: current.execId,
  };
}

/** Same delayed zombie failure as workbench acceptance, plus an independently
 * escaping double-fork/setsid descendant. Job control remains enabled. */
export function nativeCanaryControlProgram(path: string): string {
  requireCanary(
    /^\/workspace\/sandbox_native_[a-f0-9-]{36}$/u.test(path),
    "invalid native fixture path",
  );
  return [
    "#!/bin/bash",
    "set -eu",
    "trap '' INT TERM HUP",
    `printf '%s %s' "$$" "$(ps -o pgid= -p $$ | tr -d ' ')" > '${path}/child-group'`,
    "python3 - <<'NATIVE_ESCAPED' &",
    "import os,signal,time",
    "if os.fork(): os._exit(0)",
    "os.setsid()",
    "if os.fork(): os._exit(0)",
    "signal.signal(signal.SIGINT,signal.SIG_IGN)",
    "signal.signal(signal.SIGTERM,signal.SIG_IGN)",
    "signal.signal(signal.SIGHUP,signal.SIG_IGN)",
    `open('${path}/escaped-ready','x').write('READY')`,
    "time.sleep(30)",
    `open('${path}/escaped-zombie','x').write('ZOMBIE')`,
    "NATIVE_ESCAPED",
    `printf READY > '${path}/ready'`,
    "sleep 30",
    `printf ZOMBIE > '${path}/zombie'`,
    "",
  ].join("\n");
}

export async function startNativeCanaryShell(
  tools: ReturnType<typeof nativeCanaryTools>,
  pty: boolean,
) {
  const fixture = await prepareNativeCanaryControlProgram(tools);
  const { path } = fixture;
  const banner = parseExecResponseBanner(await tools.exec("bash --noprofile --norc", pty));
  requireCanary(banner.kind === "running", "native bare shell did not yield a turn-owned receipt");
  await tools.input(
    banner.sessionId,
    `printf '%s %s' "$$" "$(ps -o pgid= -p $$ | tr -d ' ')" > '${path}/shell-group'; bash '${path}/control-test.sh'\n`,
  );
  await waitNativeCanaryControlReady(tools, path);
  if (pty) {
    await tools.command(
      `test "$(cut -d ' ' -f 2 '${path}/shell-group')" != "$(cut -d ' ' -f 2 '${path}/child-group')"`,
    );
  }
  return { ...fixture, sessionId: banner.sessionId };
}

export async function prepareNativeCanaryControlProgram(
  tools: ReturnType<typeof nativeCanaryTools>,
) {
  const path = `/workspace/sandbox_native_${crypto.randomUUID()}`;
  const program = nativeCanaryControlProgram(path);
  const encoded = Buffer.from(program).toString("base64");
  await tools.command(
    `mkdir '${path}' && printf '%s' '${encoded}' | base64 -d > '${path}/control-test.sh'`,
  );
  return { path, programHash: createHash("sha256").update(program).digest("hex") };
}

export async function waitNativeCanaryControlReady(
  tools: ReturnType<typeof nativeCanaryTools>,
  path: string,
) {
  requireCanary(
    /^\/workspace\/sandbox_native_[a-f0-9-]{36}$/u.test(path),
    "invalid native fixture path",
  );
  const program =
    `import pathlib,time\np=pathlib.Path("${path}")\nd=time.monotonic()+5\n` +
    `while not ((p/"ready").exists() and (p/"escaped-ready").exists()):\n` +
    ` if time.monotonic()>d: raise RuntimeError("fixture not ready")\n time.sleep(0.05)\n`;
  await tools.command(
    `printf '%s' '${Buffer.from(program).toString("base64")}' | base64 -d | python3`,
  );
}

export function assertNativeCanaryCompletion(
  row: NativeSettledProjection | undefined,
  pty: boolean,
) {
  requireCanary(row, "native completed command projection is missing");
  const command = ModalRouterProviderCommand.safeParse(row.providerCommand);
  const receipt = CommandSupervisionReceipt.safeParse(row.supervisionReceipt);
  const protocol = pty ? "native-subreaper-pty-v1" : "native-subreaper-v1";
  requireCanary(
    command.success &&
      receipt.success &&
      command.data.supervision?.protocol === protocol &&
      Boolean(command.data.pty) === pty &&
      receipt.data.protocol === protocol &&
      receipt.data.invocationId === command.data.supervision.invocationId,
    "completed native command has no exact protocol/invocation receipt",
  );
  requireCanary(
    row.state === "exited" &&
      row.exitCode === 0 &&
      receipt.data.leaderExitCode === 0 &&
      row.supervisionOutputCaptured &&
      row.remainingHolders === 0 &&
      row.remainingAdmissions === 0 &&
      [command.data.streams.stdout, command.data.streams.stderr].every(
        (cursor) => cursor.eof && cursor.exitCode === 0 && cursor.utf8Remainder === "",
      ),
    "completed native command lacks physical settlement and captured router EOF",
  );
  return {
    protocol,
    invocationId: receipt.data.invocationId,
    receiptId: receipt.data.receiptId,
    instanceId: command.data.sandboxId,
    taskId: command.data.taskId,
    execId: command.data.execId,
    outputCaptured: true,
  };
}

export function nativeCanaryEvidenceHash(proofs: unknown): string {
  return createHash("sha256").update(JSON.stringify(proofs)).digest("hex");
}
