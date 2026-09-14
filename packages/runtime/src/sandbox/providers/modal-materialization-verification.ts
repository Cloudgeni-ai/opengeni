import {
  SandboxMaterializationVerificationError,
  retainMaterializationVerificationDiagnostic,
  type MaterializationVerificationDiagnostic,
} from "../materialization-verification-error";
import type { ModalCommandControl, ModalProviderCommand } from "./modal-command-control";

const MARKER = "__OPENGENI_MATERIALIZED_PATH_VISIBLE__";
const OUTPUT_LIMIT = 16 * 1024;

/** A fixed read-only probe, not an admitted user command. Advance its private
 * provider cursor locally; never borrow the surrounding mutation's retained
 * handle or relax retained-command persistence requirements. The caller keeps
 * the original backend and provider-operation gate for the entire observation.
 */
export async function verifyModalMaterializedPath(
  control: Pick<ModalCommandControl, "start" | "read">,
  path: string,
  workdir: string,
  pending: Set<AbortController>,
  observationTimeoutMs = 30_000,
): Promise<void> {
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = `test -e ${quote(path)} && printf %s ${quote(MARKER)}`;
  const cancellation = new AbortController();
  let deadlineExpired = false;
  let providerCommand: ModalProviderCommand | undefined;
  let stdout = "";
  let stderr = "";
  const diagnostic = (
    reason: MaterializationVerificationDiagnostic["reason"],
    exitCode: number | null = null,
  ): MaterializationVerificationDiagnostic => ({
    reason,
    path,
    workdir,
    command,
    output: (stdout + stderr).slice(0, OUTPUT_LIMIT),
    exitCode,
    providerSessionId: null,
    ...(providerCommand
      ? {
          providerExecution: {
            sandboxId: providerCommand.sandboxId,
            taskId: providerCommand.taskId,
            execId: providerCommand.execId,
          },
        }
      : {}),
  });
  const timer = setTimeout(() => {
    deadlineExpired = true;
    cancellation.abort(new Error("Materialization visibility observation deadline exceeded"));
  }, observationTimeoutMs);
  timer.unref();
  pending.add(cancellation);
  try {
    providerCommand = await control.start(
      { cmd: command, workdir, shell: "sh", login: false, tty: false },
      cancellation.signal,
    );
    for (;;) {
      cancellation.signal.throwIfAborted();
      const page = await control.read(providerCommand, 1_000, cancellation.signal);
      // Cancellation ends observation, not the process. Never accept a late
      // success after the attempt requested cancellation.
      cancellation.signal.throwIfAborted();
      if (
        page.command.sandboxId !== providerCommand.sandboxId ||
        page.command.taskId !== providerCommand.taskId ||
        page.command.execId !== providerCommand.execId
      ) {
        throw new SandboxMaterializationVerificationError(diagnostic("invalid_response"));
      }
      providerCommand = page.command;
      for (const chunk of page.chunks) {
        if (chunk.stream === "stdout") stdout += chunk.text;
        else stderr += chunk.text;
      }
      if (stdout.length + stderr.length > OUTPUT_LIMIT) {
        throw new SandboxMaterializationVerificationError(diagnostic("invalid_response"));
      }
      if (page.exitCode === null) {
        // An empty provider page may return immediately. Yield to cancellation
        // and the deadline instead of starving timers with resolved promises.
        await new Promise<void>((resolve) => setImmediate(resolve));
        continue;
      }
      if (page.exitCode === 0 && stdout === MARKER) return;
      throw new SandboxMaterializationVerificationError(
        diagnostic(
          page.exitCode === 1
            ? "path_not_visible"
            : page.exitCode === 0
              ? "invalid_response"
              : "command_failed",
          page.exitCode,
        ),
      );
    }
  } catch (error) {
    if (deadlineExpired) {
      throw new SandboxMaterializationVerificationError(
        {
          ...diagnostic("command_pending"),
          causeMessage: "Observation deadline exceeded; provider process completion is unconfirmed",
        },
        { cause: error },
      );
    }
    if (!(error instanceof SandboxMaterializationVerificationError)) {
      retainMaterializationVerificationDiagnostic(error, {
        ...diagnostic("command_error"),
        causeMessage: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    pending.delete(cancellation);
  }
}
