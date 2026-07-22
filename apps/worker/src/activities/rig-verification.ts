import type {
  AccessGrant,
  Rig,
  RigChange,
  RigCheckResult,
  RigSetupResult,
  RigVersion,
} from "@opengeni/contracts";
import { candidateRigVersionForChange, recordRigAuditEvent } from "@opengeni/core";
import {
  beginRigChangeVerificationAttempt,
  getRig,
  getRigChange,
  getRigVersionById,
  RigVerificationAttemptChangedError,
  sanitizeEventPayload,
  sanitizeEventString,
  sanitizeMemoryText,
  settleRigChangeVerificationAttempt,
  type Database,
} from "@opengeni/db";
import {
  establishSandboxSessionFromEnvelope,
  rigSetupArtifactExecutionCommand,
  sandboxCommandExitCode,
  sandboxCommandOutput,
  sandboxCommandStillRunning,
  type EstablishedSandboxSession,
} from "@opengeni/runtime";
import { settingsWithRigImage } from "./packs";
import type { ActivityServices } from "./types";

export type RigVerificationWorkflowInput =
  | { workspaceId: string; changeId: string; attempt?: number; versionId?: never }
  | { workspaceId: string; versionId: string; changeId?: never; attempt?: never };

type CommandSession = {
  exec?: (args: Record<string, unknown>) => Promise<unknown>;
  execCommand?: (args: Record<string, unknown>) => Promise<unknown>;
};

type VerificationExecutionResult = {
  status: "passed" | "failed";
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut?: boolean;
  infrastructureError?: string;
};

const OUTPUT_TAIL_LIMIT = 64 * 1024;
const EXEC_TIMEOUT_GRACE_MS = 7_000;
export const RIG_VERIFICATION_AGGREGATE_TIMEOUT_MS = 12 * 60 * 1_000;
export const RIG_VERIFICATION_CLEANUP_TIMEOUT_MS = 30 * 1_000;

function tail(value: string, limit = OUTPUT_TAIL_LIMIT): string {
  return value.length > limit ? value.slice(-limit) : value;
}

function scrubVerificationOutput(value: string): string {
  // sanitizeMemoryText provides the shared credential-pattern redaction but is
  // intentionally single-line. Apply it per line so command evidence keeps its
  // readable log structure without persisting credential-shaped values.
  return sanitizeEventString(value)
    .split("\n")
    .map((line) => sanitizeMemoryText(line).text)
    .join("\n");
}

function scrubVerificationPayload<T>(value: T): T {
  return sanitizeEventPayload(value);
}

function systemGrant(rig: Rig): AccessGrant {
  return {
    accountId: rig.accountId,
    workspaceId: rig.workspaceId,
    subjectId: "system:rig-verification",
    // Verification may read/write its attempt and audit record. It never holds
    // rigs:manage and has no activation path.
    permissions: ["rigs:use"],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function boundedCleanupCall(
  label: string,
  operation: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Tear down a verification-only sandbox before any durable outcome is written.
 * The provider client's state-aware delete is preferred; if it is unavailable,
 * times out, or fails, each session-level primitive is tried in order. Every
 * call is bounded, and failure is returned to the caller instead of being
 * hidden behind best-effort cleanup.
 */
export async function terminateThrowaway(
  established: EstablishedSandboxSession | null,
  timeoutMs = RIG_VERIFICATION_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  if (!established) return;

  const failures: string[] = [];
  const client = established.client as { delete?: (state: unknown) => Promise<unknown> } | null;
  if (typeof client?.delete === "function" && established.sessionState !== undefined) {
    try {
      await boundedCleanupCall(
        "client.delete",
        () => client.delete!(established.sessionState),
        timeoutMs,
      );
      return;
    } catch (error) {
      failures.push(`client.delete: ${errorMessage(error)}`);
    }
  }

  const session = established.session as {
    terminate?: () => Promise<unknown>;
    kill?: () => Promise<unknown>;
    close?: () => Promise<unknown>;
    closed?: boolean;
  } | null;
  const primitives: Array<[string, (() => Promise<unknown>) | undefined]> = [
    [
      "session.terminate",
      typeof session?.terminate === "function" ? () => session.terminate!() : undefined,
    ],
    ["session.kill", typeof session?.kill === "function" ? () => session.kill!() : undefined],
    [
      "session.close",
      session?.closed || typeof session?.close !== "function" ? undefined : () => session.close!(),
    ],
  ];
  for (const [label, primitive] of primitives) {
    if (!primitive) continue;
    try {
      await boundedCleanupCall(label, primitive, timeoutMs);
      return;
    } catch (error) {
      failures.push(`${label}: ${errorMessage(error)}`);
    }
  }

  const detail =
    failures.length > 0
      ? failures.join("; ")
      : "no client.delete(sessionState), session.terminate(), session.kill(), or session.close() primitive is available";
  throw new Error(
    `Rig verification sandbox cleanup failed for ${established.instanceId || "unknown instance"}: ${scrubVerificationOutput(tail(detail))}`,
  );
}

/**
 * Execute one artifact in one Bash process. The provider yield is not a
 * deadline, so the command carries an in-sandbox coreutils timeout and the
 * outer call waits only for that deadline plus bounded cleanup grace.
 */
export async function runRigVerificationScript(
  session: CommandSession,
  script: string,
  timeoutMs: number,
  executionGraceMs = EXEC_TIMEOUT_GRACE_MS,
  options: { aggregateDeadlineLimited?: boolean } = {},
): Promise<VerificationExecutionResult> {
  const command = [
    "set -u",
    rigSetupArtifactExecutionCommand(script, timeoutMs),
    "__OG_RIG_RC=$?",
    'rm -f "$__OG_RIG_SCRIPT"',
    'exit "$__OG_RIG_RC"',
  ].join("\n");
  const started = Date.now();
  const args = {
    cmd: command,
    workdir: "/workspace",
    yieldTimeMs: timeoutMs + executionGraceMs,
    maxOutputTokens: 40_000,
  };
  const execute = session.exec
    ? session.exec(args)
    : session.execCommand
      ? session.execCommand(args)
      : Promise.reject(new Error("Sandbox session does not support command execution"));
  const deadline = Symbol("rig-verification-exec-deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: unknown;
  try {
    const raced = await Promise.race([
      execute,
      new Promise<typeof deadline>((resolve) => {
        timer = setTimeout(() => resolve(deadline), timeoutMs + executionGraceMs);
      }),
    ]);
    if (raced === deadline) {
      const message = options.aggregateDeadlineLimited
        ? `rig verification aggregate command deadline exhausted while running a ${timeoutMs}ms artifact timeout`
        : `sandbox command did not return within ${timeoutMs + executionGraceMs}ms`;
      return {
        status: "failed",
        exitCode: null,
        durationMs: Math.max(0, Date.now() - started),
        timedOut: true,
        infrastructureError: message,
        output: scrubVerificationOutput(message),
      };
    }
    result = raced;
  } catch (error) {
    const message = tail(error instanceof Error ? error.message : String(error));
    return {
      status: "failed",
      exitCode: null,
      durationMs: Math.max(0, Date.now() - started),
      infrastructureError: message,
      output: scrubVerificationOutput(message),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const durationMs = Math.max(0, Date.now() - started);
  const exitCode = sandboxCommandExitCode(result);
  const stillRunning = sandboxCommandStillRunning(result);
  const timedOut = stillRunning || exitCode === 124 || exitCode === 137;
  const infrastructureError =
    options.aggregateDeadlineLimited && timedOut
      ? `rig verification aggregate command deadline exhausted during a ${timeoutMs}ms artifact timeout`
      : stillRunning
        ? `sandbox command was still running after ${timeoutMs + executionGraceMs}ms`
        : exitCode === null
          ? "sandbox command returned no exit code"
          : undefined;
  return {
    status: !stillRunning && exitCode === 0 ? "passed" : "failed",
    exitCode,
    durationMs,
    ...(timedOut ? { timedOut: true } : {}),
    ...(infrastructureError ? { infrastructureError } : {}),
    output: scrubVerificationOutput(tail(sandboxCommandOutput(result))),
  };
}

function assertUniqueCheckNames(checks: RigVersion["checks"]): void {
  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.name)) {
      throw new Error(`duplicate rig check name: ${check.name}`);
    }
    seen.add(check.name);
  }
}

async function loadChangeTarget(
  db: Database,
  workspaceId: string,
  changeId: string,
): Promise<{ rig: Rig; baseVersion: RigVersion; change: RigChange }> {
  const change = await getRigChange(db, workspaceId, changeId);
  if (!change) throw new Error(`Rig change not found: ${changeId}`);
  const rig = await getRig(db, workspaceId, change.rigId);
  if (!rig) throw new Error(`Rig not found for change: ${change.rigId}`);
  if (!change.baseVersionId) throw new Error(`Rig change ${change.id} has no base version`);
  const baseVersion = await getRigVersionById(db, workspaceId, change.baseVersionId);
  if (!baseVersion || baseVersion.rigId !== rig.id) {
    throw new Error(`Base rig version not found: ${change.baseVersionId}`);
  }
  return { rig, baseVersion, change };
}

async function assertChangeBaseIsActive(
  db: Database,
  workspaceId: string,
  rigId: string,
  baseVersionId: string,
): Promise<void> {
  const current = await getRig(db, workspaceId, rigId);
  if (!current || current.activeVersion?.id !== baseVersionId) {
    throw new Error(
      `rig active version changed during verification (expected ${baseVersionId}, current ${current?.activeVersion?.id ?? "none"})`,
    );
  }
}

async function loadVersionTarget(
  db: Database,
  workspaceId: string,
  versionId: string,
): Promise<{ rig: Rig; version: RigVersion }> {
  const version = await getRigVersionById(db, workspaceId, versionId);
  if (!version) throw new Error(`Rig version not found: ${versionId}`);
  const rig = await getRig(db, workspaceId, version.rigId);
  if (!rig) throw new Error(`Rig not found for version: ${version.rigId}`);
  return { rig, version };
}

function skippedSetup(reason: string): RigSetupResult {
  return { status: "skipped", exitCode: null, durationMs: 0, skippedReason: reason };
}

export async function runCandidate(
  session: CommandSession,
  version: RigVersion,
  timeoutMs: number,
  aggregateDeadlineAt = Date.now() + RIG_VERIFICATION_AGGREGATE_TIMEOUT_MS,
  now = Date.now,
): Promise<{
  setupResult: RigSetupResult;
  checkResults: RigCheckResult[];
  checksConfigured: boolean;
  passed: boolean;
  infrastructureError?: string;
}> {
  assertUniqueCheckNames(version.checks);
  const runArtifact = async (script: string): Promise<VerificationExecutionResult | null> => {
    const remainingMs = aggregateDeadlineAt - now();
    if (remainingMs <= 0) return null;
    const effectiveTimeoutMs = Math.min(timeoutMs, remainingMs);
    return await runRigVerificationScript(
      session,
      script,
      effectiveTimeoutMs,
      EXEC_TIMEOUT_GRACE_MS,
      {
        aggregateDeadlineLimited: remainingMs <= timeoutMs,
      },
    );
  };
  const setupScript = (version.setupScript ?? "").trim();
  const setupExecution = setupScript ? await runArtifact(version.setupScript!) : null;
  const setupDeadlineExpired = setupScript !== "" && setupExecution === null;
  const setupInfrastructureError = setupExecution?.infrastructureError;
  const setupResult: RigSetupResult = setupExecution
    ? {
        status: setupExecution.status,
        exitCode: setupExecution.exitCode,
        output: setupExecution.output,
        durationMs: setupExecution.durationMs,
        ...(setupExecution.timedOut ? { timedOut: true } : {}),
      }
    : setupDeadlineExpired
      ? skippedSetup("Aggregate verification command deadline expired before setup could run.")
      : skippedSetup("Candidate has no setup script configured.");
  const checkResults: RigCheckResult[] = [];
  let infrastructureError =
    setupInfrastructureError ??
    (setupDeadlineExpired
      ? "rig verification aggregate command deadline expired before setup"
      : undefined);
  if (
    !infrastructureError &&
    (setupResult.status === "passed" || setupResult.status === "skipped")
  ) {
    for (const check of version.checks) {
      if (infrastructureError) {
        checkResults.push({
          name: check.name,
          command: scrubVerificationOutput(check.command),
          status: "skipped",
          exitCode: null,
          durationMs: 0,
          skippedReason: infrastructureError.includes("aggregate command deadline")
            ? "Aggregate verification command deadline expired before this check could run."
            : "A prior check could not be executed reliably; the verifier stopped using this sandbox.",
        });
        continue;
      }
      const execution = await runArtifact(check.command);
      if (!execution) {
        checkResults.push({
          name: check.name,
          command: scrubVerificationOutput(check.command),
          status: "skipped",
          exitCode: null,
          durationMs: 0,
          skippedReason:
            "Aggregate verification command deadline expired before this check could run.",
        });
        infrastructureError = "rig verification aggregate command deadline expired before check";
        continue;
      }
      checkResults.push({
        name: check.name,
        command: scrubVerificationOutput(check.command),
        status: execution.status,
        exitCode: execution.exitCode,
        output: execution.output,
        durationMs: execution.durationMs,
        ...(execution.timedOut ? { timedOut: true } : {}),
      });
      infrastructureError = execution.infrastructureError;
    }
  } else {
    for (const check of version.checks) {
      checkResults.push({
        name: check.name,
        command: scrubVerificationOutput(check.command),
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        skippedReason: setupInfrastructureError?.includes("aggregate command deadline")
          ? "Aggregate verification command deadline expired before this check could run."
          : setupInfrastructureError
            ? "Candidate setup could not be executed reliably; this check did not run."
            : "Candidate setup failed; this check could not run in the prepared sandbox.",
      });
    }
  }
  return {
    setupResult,
    checkResults,
    checksConfigured: version.checks.length > 0,
    passed:
      setupResult.status !== "failed" &&
      !infrastructureError &&
      checkResults.length === version.checks.length &&
      checkResults.every((result) => result.status === "passed"),
    ...(infrastructureError ? { infrastructureError } : {}),
  };
}

function attemptNumber(change: RigChange): number | null {
  const attempt = change.verification?.attempt;
  return typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0 ? attempt : null;
}

export function createRigVerificationActivities(services: () => Promise<ActivityServices>) {
  return {
    verifyRigChange: async (input: { workspaceId: string; changeId: string; attempt?: number }) => {
      const { settings, db } = await services();
      const { rig, baseVersion, change } = await loadChangeTarget(
        db,
        input.workspaceId,
        input.changeId,
      );
      const grant = systemGrant(rig);
      const verifying =
        input.attempt !== undefined
          ? change
          : await beginRigChangeVerificationAttempt(db, input.workspaceId, change.id, {
              startedAt: new Date().toISOString(),
              allowAlreadyVerifying: true,
            });
      const attempt = attemptNumber(verifying);
      if (
        verifying.status !== "verifying" ||
        !attempt ||
        (input.attempt !== undefined && input.attempt !== attempt)
      ) {
        throw new RigVerificationAttemptChangedError(
          change.id,
          input.attempt ?? -1,
          attempt,
          verifying.status,
        );
      }
      const startedAt =
        typeof verifying.verification?.startedAt === "string"
          ? verifying.verification.startedAt
          : new Date().toISOString();
      await recordRigAuditEvent(db, {
        grant,
        action: "rig.verification.started",
        rigId: rig.id,
        metadata: { changeId: change.id, attempt },
      });

      let established: EstablishedSandboxSession | null = null;
      let candidate: RigVersion | null = null;
      const verification: Record<string, unknown> = {
        attempt,
        startedAt,
        checkResults: [],
      };
      let cleanupAttempted = false;
      let cleanupError: Error | undefined;
      const cleanupBeforeDurableWrite = async (): Promise<Error | undefined> => {
        if (cleanupAttempted) return cleanupError;
        cleanupAttempted = true;
        try {
          await terminateThrowaway(established);
        } catch (error) {
          cleanupError = new Error(
            scrubVerificationOutput(
              `Rig verification cleanup failed before durable settlement: ${errorMessage(error)}`,
            ),
          );
        }
        return cleanupError;
      };
      try {
        const aggregateDeadlineAt = Date.now() + RIG_VERIFICATION_AGGREGATE_TIMEOUT_MS;
        await assertChangeBaseIsActive(db, input.workspaceId, rig.id, baseVersion.id);
        const builtCandidate = candidateRigVersionForChange(baseVersion, change);
        assertUniqueCheckNames(builtCandidate.checks);
        candidate = builtCandidate;
        verification.checksConfigured = candidate.checks.length > 0;
        const runSettings = settingsWithRigImage(settings, candidate.image);
        established = await establishSandboxSessionFromEnvelope(runSettings, null, {
          sessionId: `rig-verification-${change.id}-attempt-${attempt}`,
          recovery: "create-or-restore",
          environment: {},
        });
        const result = await runCandidate(
          established.session as CommandSession,
          candidate,
          settings.rigSetupTimeoutMs,
          aggregateDeadlineAt,
        );
        const { infrastructureError, ...structuredResult } = result;
        Object.assign(verification, structuredResult, {
          finishedAt: new Date().toISOString(),
          ...(infrastructureError ? { error: scrubVerificationOutput(infrastructureError) } : {}),
        });

        const cleanupFailure = await cleanupBeforeDurableWrite();
        if (cleanupFailure) {
          Object.assign(verification, {
            passed: false,
            error: scrubVerificationOutput(cleanupFailure.message),
          });
        }

        if (infrastructureError || cleanupFailure) {
          const failed = await settleRigChangeVerificationAttempt(
            db,
            input.workspaceId,
            change.id,
            attempt,
            { status: "failed", verification: scrubVerificationPayload(verification) },
          );
          await recordRigAuditEvent(db, {
            grant,
            action: "rig.verification.failed",
            rigId: rig.id,
            metadata: { changeId: change.id, attempt, status: "failed" },
          });
          await recordRigAuditEvent(db, {
            grant,
            action: "rig.change.failed",
            rigId: rig.id,
            metadata: { changeId: change.id, attempt },
          });
          return failed;
        }

        if (!result.passed) {
          const rejected = await settleRigChangeVerificationAttempt(
            db,
            input.workspaceId,
            change.id,
            attempt,
            { status: "rejected", verification: scrubVerificationPayload(verification) },
          );
          await recordRigAuditEvent(db, {
            grant,
            action: "rig.verification.failed",
            rigId: rig.id,
            metadata: { changeId: change.id, attempt, status: "rejected" },
          });
          await recordRigAuditEvent(db, {
            grant,
            action: "rig.change.rejected",
            rigId: rig.id,
            metadata: { changeId: change.id, attempt },
          });
          return rejected;
        }

        // OCC fence again after the potentially long clean run. A candidate
        // verified against a version that stopped being active is never marked
        // promotable.
        await assertChangeBaseIsActive(db, input.workspaceId, rig.id, baseVersion.id);
        const verified = await settleRigChangeVerificationAttempt(
          db,
          input.workspaceId,
          change.id,
          attempt,
          { status: "proposed", verification: scrubVerificationPayload(verification) },
        );
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.verification.passed",
          rigId: rig.id,
          metadata: {
            changeId: change.id,
            attempt,
            status: "verified_awaiting_manager",
            checksConfigured: result.checksConfigured,
          },
        });
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.change.verified",
          rigId: rig.id,
          metadata: { changeId: change.id, attempt },
        });
        return verified;
      } catch (error) {
        if (error instanceof RigVerificationAttemptChangedError) {
          const cleanupFailure = await cleanupBeforeDurableWrite();
          if (cleanupFailure) throw cleanupFailure;
          const current = await getRigChange(db, input.workspaceId, change.id);
          if (current) return current;
          throw error;
        }
        if (candidate && !verification.setupResult) {
          verification.setupResult = skippedSetup(
            "Candidate setup did not run because verification infrastructure failed.",
          );
          verification.checkResults = candidate.checks.map(
            (check) =>
              ({
                name: check.name,
                command: scrubVerificationOutput(check.command),
                status: "skipped",
                exitCode: null,
                durationMs: 0,
                skippedReason:
                  "Verification infrastructure failed before this declared check could run.",
              }) satisfies RigCheckResult,
          );
        }
        Object.assign(verification, {
          finishedAt: new Date().toISOString(),
          passed: false,
          error: scrubVerificationOutput(
            tail(error instanceof Error ? error.message : String(error)),
          ),
        });
        const cleanupFailure = await cleanupBeforeDurableWrite();
        if (cleanupFailure) {
          verification.error = scrubVerificationOutput(cleanupFailure.message);
        }
        let failed: RigChange;
        try {
          failed = await settleRigChangeVerificationAttempt(
            db,
            input.workspaceId,
            change.id,
            attempt,
            { status: "failed", verification: scrubVerificationPayload(verification) },
          );
        } catch (settleError) {
          if (settleError instanceof RigVerificationAttemptChangedError) {
            const current = await getRigChange(db, input.workspaceId, change.id);
            if (current) return current;
          }
          throw settleError;
        }
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.verification.failed",
          rigId: rig.id,
          metadata: { changeId: change.id, attempt, status: "failed" },
        });
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.change.failed",
          rigId: rig.id,
          metadata: { changeId: change.id, attempt },
        });
        return failed;
      }
    },

    failRigChangeVerification: async (input: {
      workspaceId: string;
      changeId: string;
      attempt: number;
      reason: string;
    }): Promise<void> => {
      const { db } = await services();
      const change = await getRigChange(db, input.workspaceId, input.changeId);
      if (!change) return;
      const rig = await getRig(db, input.workspaceId, change.rigId);
      if (!rig) return;
      const verification = {
        finishedAt: new Date().toISOString(),
        passed: false,
        error: scrubVerificationOutput(tail(input.reason)),
      };
      try {
        await settleRigChangeVerificationAttempt(db, input.workspaceId, change.id, input.attempt, {
          status: "failed",
          verification: scrubVerificationPayload(verification),
        });
      } catch (error) {
        if (error instanceof RigVerificationAttemptChangedError) return;
        throw error;
      }
      await recordRigAuditEvent(db, {
        grant: systemGrant(rig),
        action: "rig.verification.failed",
        rigId: rig.id,
        metadata: { changeId: change.id, attempt: input.attempt, status: "failed" },
      });
      await recordRigAuditEvent(db, {
        grant: systemGrant(rig),
        action: "rig.change.failed",
        rigId: rig.id,
        metadata: { changeId: change.id, attempt: input.attempt },
      });
    },

    verifyRigVersion: async (input: { workspaceId: string; versionId: string }) => {
      const { settings, db } = await services();
      const { rig, version } = await loadVersionTarget(db, input.workspaceId, input.versionId);
      const grant = systemGrant(rig);
      const startedAt = new Date().toISOString();
      if (version.checks.length === 0) {
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.verification.no_checks",
          rigId: rig.id,
          metadata: {
            versionId: version.id,
            startedAt,
            finishedAt: new Date().toISOString(),
            passed: null,
            checksConfigured: false,
          },
        });
        return { versionId: version.id, passed: null, checksConfigured: false, checkResults: [] };
      }
      await recordRigAuditEvent(db, {
        grant,
        action: "rig.verification.started",
        rigId: rig.id,
        metadata: { versionId: version.id },
      });
      let established: EstablishedSandboxSession | null = null;
      let cleanupAttempted = false;
      let cleanupError: Error | undefined;
      const cleanupBeforeAudit = async (): Promise<Error | undefined> => {
        if (cleanupAttempted) return cleanupError;
        cleanupAttempted = true;
        try {
          await terminateThrowaway(established);
        } catch (error) {
          cleanupError = new Error(
            scrubVerificationOutput(
              `Rig verification cleanup failed before verification audit: ${errorMessage(error)}`,
            ),
          );
        }
        return cleanupError;
      };
      try {
        assertUniqueCheckNames(version.checks);
        const aggregateDeadlineAt = Date.now() + RIG_VERIFICATION_AGGREGATE_TIMEOUT_MS;
        const runSettings = settingsWithRigImage(settings, version.image);
        established = await establishSandboxSessionFromEnvelope(runSettings, null, {
          sessionId: `rig-version-verification-${version.id}-${crypto.randomUUID()}`,
          recovery: "create-or-restore",
          environment: {},
        });
        const result = await runCandidate(
          established.session as CommandSession,
          version,
          settings.rigSetupTimeoutMs,
          aggregateDeadlineAt,
        );
        const { infrastructureError, ...structuredResult } = result;
        const cleanupFailure = await cleanupBeforeAudit();
        const auditResult = cleanupFailure
          ? {
              ...structuredResult,
              passed: false,
              infrastructureError: cleanupFailure.message,
            }
          : {
              ...structuredResult,
              ...(infrastructureError ? { infrastructureError } : {}),
            };
        await recordRigAuditEvent(db, {
          grant,
          action: auditResult.passed ? "rig.verification.passed" : "rig.verification.failed",
          rigId: rig.id,
          metadata: scrubVerificationPayload({
            versionId: version.id,
            startedAt,
            finishedAt: new Date().toISOString(),
            ...auditResult,
            ...(auditResult.infrastructureError
              ? { error: scrubVerificationOutput(auditResult.infrastructureError) }
              : {}),
          }),
        });
        return {
          versionId: version.id,
          ...auditResult,
          ...(auditResult.infrastructureError
            ? { error: scrubVerificationOutput(auditResult.infrastructureError) }
            : {}),
        };
      } catch (error) {
        const cleanupFailure = await cleanupBeforeAudit();
        const detail = tail(
          scrubVerificationOutput(
            cleanupFailure?.message ?? (error instanceof Error ? error.message : String(error)),
          ),
          4_096,
        );
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.verification.failed",
          rigId: rig.id,
          metadata: scrubVerificationPayload({
            versionId: version.id,
            startedAt,
            finishedAt: new Date().toISOString(),
            passed: false,
            error: detail,
          }),
        });
        throw cleanupFailure ?? error;
      }
    },
  };
}
