import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  SandboxMaterializationVerificationError,
  retainMaterializationVerificationDiagnostic,
  type MaterializationVerificationDiagnostic,
} from "../materialization-verification-error";
import type { ModalCommandControl, ModalProviderCommand } from "./modal-command-control";
import {
  ProviderCommandObservationUnavailableError,
  ProviderCommandStartOutcomeUnknownError,
  type ProviderCommandOutput,
} from "../provider-command-session";

const MARKER = "__OPENGENI_MATERIALIZED_PATH_VISIBLE__";
const OUTPUT_LIMIT = 16 * 1024;

/** A fixed read-only probe, not an admitted user command. Advance its private
 * provider cursor locally; never borrow the surrounding mutation's retained
 * handle or relax retained-command persistence requirements. The caller keeps
 * the original backend and provider-operation gate for the entire observation.
 */
export async function verifyModalMaterializedPath(
  control: Pick<ModalCommandControl, "start" | "readProbe">,
  path: string,
  workdir: string,
  pending: Set<AbortController>,
  observationTimeoutMs = 30_000,
): Promise<void> {
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = `test -e ${quote(path)} && printf %s ${quote(MARKER)}`;
  const cancellation = new AbortController();
  const deadlineReason = new Error("Materialization visibility observation deadline exceeded");
  let providerCommand: ModalProviderCommand | undefined;
  let startUnknown: ProviderCommandStartOutcomeUnknownError | undefined;
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
    cancellation.abort(deadlineReason);
  }, observationTimeoutMs);
  timer.unref();
  pending.add(cancellation);
  try {
    try {
      providerCommand = await control.start(
        { cmd: command, workdir, shell: "sh", login: false, tty: false },
        cancellation.signal,
      );
    } catch (error) {
      // A possibly dispatched fixed visibility probe has one original locator.
      // Observe that invocation; never replay it or the surrounding mutation.
      if (!(error instanceof ProviderCommandStartOutcomeUnknownError)) throw error;
      providerCommand = structuredClone(error.command);
      startUnknown = error;
    }
    for (;;) {
      cancellation.signal.throwIfAborted();
      let page: ProviderCommandOutput;
      try {
        page = await control.readProbe(providerCommand, 1_000, cancellation);
      } catch (error) {
        cancellation.signal.throwIfAborted();
        if (
          !(error instanceof ProviderCommandObservationUnavailableError) ||
          !error.readRetryAllowed
        ) {
          if (!startUnknown) throw error;
          // A missing/denied read cannot disprove the original Start. Preserve
          // its exact invocation without granting any further read retry.
          throw new ProviderCommandObservationUnavailableError(
            structuredClone(providerCommand),
            new AggregateError(
              [startUnknown, error],
              "Original visibility Start and observation remain uncertain",
            ),
            false,
          );
        }
        // Unavailable reads do not advance any cursor. A contradictory locator
        // is an invariant failure, never authority to inspect another process.
        if (!isDeepStrictEqual(error.command, providerCommand))
          throw new SandboxMaterializationVerificationError(diagnostic("invalid_response"), {
            cause: error,
          });
        // Read retries remain inside this probe's original thirty-second
        // deadline, including outages longer than a single bounded read.
        try {
          await delay(100, undefined, { signal: cancellation.signal });
        } catch (interrupted) {
          cancellation.signal.throwIfAborted();
          throw interrupted;
        }
        continue;
      }
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
    if (cancellation.signal.reason === deadlineReason) {
      throw new SandboxMaterializationVerificationError(
        {
          ...diagnostic("command_pending"),
          causeMessage: "Observation deadline exceeded; provider process completion is unconfirmed",
        },
        {
          cause: providerCommand
            ? new ProviderCommandObservationUnavailableError(
                providerCommand,
                startUnknown
                  ? new AggregateError(
                      [startUnknown, error],
                      "Original visibility Start and observation deadline remain uncertain",
                    )
                  : error,
              )
            : error,
        },
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
    cancellation.abort(new Error("Materialization visibility observation finished"));
    clearTimeout(timer);
    pending.delete(cancellation);
  }
}
