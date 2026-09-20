import { isDeepStrictEqual } from "node:util";
import { CommandSupervisionReceipt, ModalRouterProviderCommand } from "@opengeni/contracts";
import type { sandboxRetainedProcesses, sessionBackgroundCommands } from "@opengeni/db/schema";
import { requireCanary } from "./ope534-rotation-canary-evidence";

/** The exact 0496 projection, not an adapter-generated terminal assertion. */
export type CanarySupervisionProjection = Pick<
  typeof sandboxRetainedProcesses.$inferSelect,
  | "providerCommand"
  | "state"
  | "exitCode"
  | "settledAt"
  | "supervisionReceipt"
  | "supervisionOutputCaptured"
  | "cancellationRequestedAt"
  | "cancellationReason"
> & {
  backgroundState: typeof sessionBackgroundCommands.$inferSelect.state;
  backgroundCancelledAt: Date | null;
  backgroundExitCode: number | null;
};

export function assertCanarySupervisionReady(input: {
  enabled: boolean;
  databaseReady: boolean;
  backend: string;
}): void {
  requireCanary(input.backend === "modal", "supervision canary requires stock Modal");
  requireCanary(input.enabled === true, "supervision launch flag is disabled");
  requireCanary(input.databaseReady === true, "supervised command database gates are not ready");
}

function command(value: unknown) {
  // Never print parsing errors containing a descriptor/control capability.
  const parsed = ModalRouterProviderCommand.safeParse(value);
  requireCanary(parsed.success, "invalid durable Modal router command");
  requireCanary(
    parsed.data.pty !== true && parsed.data.supervision,
    "missing stock nonTTY supervision",
  );
  return { ...parsed.data, supervision: parsed.data.supervision };
}

function unchangedExecution(original: unknown, current: unknown) {
  const before = command(original);
  const after = command(current);
  requireCanary(
    before.sandboxId === after.sandboxId &&
      before.taskId === after.taskId &&
      before.execId === after.execId &&
      Boolean(before.pty) === Boolean(after.pty) &&
      isDeepStrictEqual(before.supervision, after.supervision),
    "supervision proof changed original provider execution or invocation",
  );
  for (const stream of ["stdout", "stderr"] as const) {
    requireCanary(
      after.streams[stream].byteOffset >= before.streams[stream].byteOffset,
      "supervision output cursor regressed",
    );
  }
  return after;
}

/** Invoke after BOTH the launch turn and later-writing turn complete. */
export function assertCompletedTurnPreservedSupervision(
  original: unknown,
  row: CanarySupervisionProjection | undefined,
): void {
  requireCanary(row, "adopted process projection is missing after completed turn");
  unchangedExecution(original, row.providerCommand);
  requireCanary(
    row.state === "active" &&
      row.exitCode === null &&
      row.settledAt === null &&
      row.backgroundState === "running" &&
      row.backgroundExitCode === null,
    "completed turn settled its adopted server",
  );
  requireCanary(
    row.cancellationRequestedAt === null &&
      row.cancellationReason === null &&
      row.backgroundCancelledAt === null,
    "completed turn requested cancellation of its adopted server",
  );
  requireCanary(
    row.supervisionReceipt === null && row.supervisionOutputCaptured === false,
    "adopted server acquired terminal supervision proof before rotation",
  );
}

/** Require the native quiescence receipt AND durable authenticated router EOF /
 * successful supervisor exit AND atomic output capture. The original leader's
 * result is separate: cancellation commonly yields nonzero while provider=0. */
export function assertSettledCanarySupervision(
  original: unknown,
  row: CanarySupervisionProjection | undefined,
  rotationRequestedAt: number,
  providerDeadlineAt: number,
) {
  requireCanary(row, "settled process projection is missing");
  const retained = unchangedExecution(original, row.providerCommand);
  const parsed = CommandSupervisionReceipt.safeParse(row.supervisionReceipt);
  requireCanary(parsed.success, "missing or invalid native quiescence receipt");
  const receipt = parsed.data;
  requireCanary(
    receipt.invocationId === retained.supervision.invocationId,
    "quiescence receipt belongs to another invocation",
  );
  requireCanary(
    row.supervisionOutputCaptured === true,
    "supervised output was not atomically captured",
  );
  for (const stream of ["stdout", "stderr"] as const) {
    const cursor = retained.streams[stream];
    requireCanary(
      cursor.eof === true && cursor.exitCode === 0 && cursor.utf8Remainder === "",
      `supervisor ${stream} lacks complete authenticated terminal output`,
    );
  }
  requireCanary(
    row.state === "exited" &&
      row.exitCode === receipt.leaderExitCode &&
      row.backgroundState === "exited" &&
      row.backgroundExitCode === receipt.leaderExitCode,
    "settled process/background result differs from original leader exit",
  );
  const cancelledAt = row.cancellationRequestedAt?.getTime() ?? NaN;
  const settledAt = row.settledAt?.getTime() ?? NaN;
  requireCanary(
    [rotationRequestedAt, providerDeadlineAt, cancelledAt, settledAt].every(Number.isFinite) &&
      row.cancellationReason === "provider_deadline" &&
      cancelledAt >= rotationRequestedAt &&
      cancelledAt <= settledAt &&
      settledAt < providerDeadlineAt,
    "supervised cancellation is not a timely provider-deadline request",
  );
  // Only non-secret proof identity enters retained canary evidence.
  return {
    protocol: receipt.protocol,
    invocationId: receipt.invocationId,
    receiptId: receipt.receiptId,
    leaderExitCode: receipt.leaderExitCode,
    providerExitCode: 0 as const,
    stdoutEof: true,
    stderrEof: true,
    outputCaptured: true,
    cancellationReason: "provider_deadline" as const,
    cancellationRequestedAt: cancelledAt,
    settledAt,
  };
}
