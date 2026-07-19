import type { AccessGrant, Rig, RigChange, RigVersion } from "@opengeni/contracts";
import {
  recordRigAuditEvent,
  classifyRigVerificationOutcome,
  promoteSetupAppendChange,
} from "@opengeni/core";
import {
  beginRigChangeVerificationAttempt,
  deactivateSandboxEphemeralOwner,
  getRig,
  getRigChange,
  getRigVersionById,
  registerSandboxEphemeralOwner,
  sanitizeEventPayload,
  sanitizeEventString,
  sanitizeMemoryText,
  updateRigChangeStatus,
  type Database,
} from "@opengeni/db";
import {
  establishSandboxSessionFromEnvelope,
  runRigSetupHook,
  sandboxCommandExitCode,
  sandboxCommandOutput,
  tagModalSandboxEphemeralOwner,
  type EstablishedSandboxSession,
} from "@opengeni/runtime";
import type { ActivityServices } from "./types";
import { settingsWithRigImage } from "./packs";

export type RigVerificationWorkflowInput =
  | { workspaceId: string; changeId: string; versionId?: never }
  | { workspaceId: string; versionId: string; changeId?: never };

type CommandResult = {
  exitCode: number | null;
  output: string;
};

type CommandSession = {
  exec?: (args: Record<string, unknown>) => Promise<unknown>;
  execCommand?: (args: Record<string, unknown>) => Promise<unknown>;
};

const OUTPUT_TAIL_LIMIT = 64 * 1024;
// The Temporal activity has a 15-minute start-to-close timeout. Keep ownership
// through that complete contract plus five minutes for cancellation delivery
// and finally cleanup; a dead process then becomes sweep-eligible without any
// lease-holder fiction or manual recovery.
export const RIG_VERIFICATION_OWNER_TTL_MS = 20 * 60_000;
export const RIG_VERIFICATION_OWNERS_DISABLED_MESSAGE =
  "Rig verification ephemeral ownership is disabled; refusing to create an unowned verifier sandbox";

function tail(value: string, limit = OUTPUT_TAIL_LIMIT): string {
  return value.length > limit ? value.slice(-limit) : value;
}

function scrubVerificationOutput(value: string): string {
  return sanitizeMemoryText(sanitizeEventString(value)).text;
}

function scrubVerificationPayload<T>(value: T): T {
  return sanitizeEventPayload(value);
}

function systemGrant(rig: Rig): AccessGrant {
  return {
    accountId: rig.accountId,
    workspaceId: rig.workspaceId,
    subjectId: "system:rig-verification",
    permissions: ["rigs:use", "rigs:manage"],
  };
}

async function terminateThrowaway(established: EstablishedSandboxSession | null): Promise<void> {
  if (!established) {
    return;
  }
  const client = established.client as { delete?: (state: unknown) => Promise<unknown> };
  if (typeof client.delete === "function" && established.sessionState !== undefined) {
    await client.delete(established.sessionState);
    return;
  }
  const session = established.session as {
    terminate?: () => Promise<unknown>;
    kill?: () => Promise<unknown>;
    close?: () => Promise<unknown>;
    closed?: boolean;
  };
  if (session.terminate) {
    await session.terminate();
  } else if (session.kill) {
    await session.kill();
  } else if (session.close && !session.closed) {
    await session.close();
  }
}

export type RigVerificationOwnershipDependencies = {
  establish: typeof establishSandboxSessionFromEnvelope;
  register: typeof registerSandboxEphemeralOwner;
  deactivate: typeof deactivateSandboxEphemeralOwner;
  tag: typeof tagModalSandboxEphemeralOwner;
  terminate: typeof terminateThrowaway;
  randomUUID: () => string;
  now: () => number;
};

const defaultOwnershipDependencies: RigVerificationOwnershipDependencies = {
  establish: establishSandboxSessionFromEnvelope,
  register: registerSandboxEphemeralOwner,
  deactivate: deactivateSandboxEphemeralOwner,
  tag: tagModalSandboxEphemeralOwner,
  terminate: terminateThrowaway,
  randomUUID: () => crypto.randomUUID(),
  now: () => Date.now(),
};

/**
 * Run one verifier against one exactly attributed standalone sandbox.
 *
 * Ordering is deliberate and source-of-truth safe:
 *   create callback -> durable owner row -> best-effort provider tags -> setup.
 * Every exact create callback is remembered before the registration await, so
 * commit-then-lost-response ambiguity still has enough identity for finally to
 * issue idempotent exact deactivation. All candidate deactivations and provider
 * termination are independent all-settled operations, so failure of one can
 * never suppress another. Expiry is the process-death/provider-delete-failure
 * backstop.
 */
export async function runWithOwnedRigVerificationSandbox<T>(
  input: {
    settings: ActivityServices["settings"];
    db: Database;
    observability: ActivityServices["observability"];
    accountId: string;
    workspaceId: string;
    sessionIdPrefix: string;
  },
  run: (established: EstablishedSandboxSession) => Promise<T>,
  dependencies: RigVerificationOwnershipDependencies = defaultOwnershipDependencies,
): Promise<T> {
  // Phase B must remain inert throughout its code rollout. A disabled or
  // omitted flag rejects before establish() can invoke any provider create;
  // falling back to the legacy unowned verifier is never safe.
  if (!input.settings.rigVerificationEphemeralOwnersEnabled) {
    throw new Error(RIG_VERIFICATION_OWNERS_DISABLED_MESSAGE);
  }

  const executionId = dependencies.randomUUID();
  let cleanupTarget: EstablishedSandboxSession | null = null;
  const createdInstanceIds = new Set<string>();
  try {
    const established = await dependencies.establish(input.settings, null, {
      sessionId: `${input.sessionIdPrefix}-${executionId}`,
      recovery: "create-or-restore",
      environment: {},
      onSandboxCreated: async (created) => {
        // Retain the exact handle even if durable attribution fails. The runtime
        // establishment seam also terminates fail-closed; finally retries the
        // provider cleanup independently.
        cleanupTarget = created;
        // Record before awaiting register(). A database commit followed by a
        // lost response is indistinguishable from a failed write to this
        // process, but exact cleanup remains safe in both cases.
        createdInstanceIds.add(created.instanceId);
        await dependencies.register(input.db, {
          executionId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          kind: "rig_verification",
          backend: input.settings.sandboxBackend,
          instanceId: created.instanceId,
          expiresAt: new Date(dependencies.now() + RIG_VERIFICATION_OWNER_TTL_MS),
        });

        if (input.settings.sandboxBackend === "modal") {
          try {
            await dependencies.tag(input.settings, created.instanceId, {
              ownerKind: "rig_verification",
              ownerId: executionId,
              workspaceId: input.workspaceId,
            });
          } catch (error) {
            input.observability.warn("rig verifier: Modal ownership tag failed", {
              executionId,
              instanceId: created.instanceId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    });
    cleanupTarget = established;
    createdInstanceIds.add(established.instanceId);
    return await run(established);
  } finally {
    const instanceIds = [...createdInstanceIds];
    // Start every operation from its own microtask. Even an injected dependency
    // that throws synchronously cannot suppress any sibling cleanup operation.
    const deactivationOperations = instanceIds.map((instanceId) =>
      Promise.resolve().then(() =>
        dependencies.deactivate(input.db, {
          executionId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          kind: "rig_verification",
          backend: input.settings.sandboxBackend,
          instanceId,
        }),
      ),
    );
    const cleanupResults = await Promise.allSettled([
      ...deactivationOperations,
      Promise.resolve().then(() => dependencies.terminate(cleanupTarget)),
    ]);

    let deactivatedExactOwner = false;
    let deactivationRejected = false;
    for (const [index, instanceId] of instanceIds.entries()) {
      const result = cleanupResults[index]!;
      if (result.status === "fulfilled" && result.value === true) {
        deactivatedExactOwner = true;
      } else if (result.status === "rejected") {
        deactivationRejected = true;
        input.observability.warn("rig verifier: ownership cleanup failed", {
          executionId,
          instanceId,
          operation: "deactivate",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
    // False is expected for stale candidates after a successful replacement
    // rebind. It is actionable only when no candidate matched and no more
    // specific database error was already reported.
    if (instanceIds.length > 0 && !deactivatedExactOwner && !deactivationRejected) {
      input.observability.warn("rig verifier: ownership cleanup failed", {
        executionId,
        instanceId: instanceIds[instanceIds.length - 1]!,
        candidateInstanceIds: instanceIds.join(","),
        operation: "deactivate",
        error:
          "no exact active ownership row was deactivated; registration may not have committed or expiry remains the backstop",
      });
    }

    const terminateResult = cleanupResults[instanceIds.length]!;
    if (terminateResult.status === "rejected") {
      input.observability.warn("rig verifier: ownership cleanup failed", {
        executionId,
        instanceId: cleanupTarget?.instanceId ?? null,
        operation: "terminate",
        error:
          terminateResult.reason instanceof Error
            ? terminateResult.reason.message
            : String(terminateResult.reason),
      });
    }
  }
}

async function runCommand(
  session: CommandSession,
  command: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const args = {
    cmd: command,
    workdir: "/workspace",
    runAs: "root",
    yieldTimeMs: timeoutMs,
    maxOutputTokens: 40_000,
  };
  const result = session.exec
    ? await session.exec(args)
    : session.execCommand
      ? await session.execCommand(args)
      : (() => {
          throw new Error("Sandbox session does not support command execution");
        })();
  return {
    exitCode: sandboxCommandExitCode(result),
    output: scrubVerificationOutput(tail(sandboxCommandOutput(result))),
  };
}

function setupAppendCommand(change: RigChange): string | null {
  if (change.kind !== "setup_append") {
    return null;
  }
  const command = (change.payload as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

function candidateVersionForChange(baseVersion: RigVersion, change: RigChange): RigVersion {
  if (change.kind !== "definition_edit") {
    return baseVersion;
  }
  const payload = change.payload as {
    image?: unknown;
    setupScript?: unknown;
    checks?: unknown;
    credentialHooks?: unknown;
    defaultVariableSetIds?: unknown;
    changelog?: unknown;
  };
  return {
    ...baseVersion,
    image: payload.image === undefined ? baseVersion.image : (payload.image as string | null),
    setupScript:
      payload.setupScript === undefined
        ? baseVersion.setupScript
        : (payload.setupScript as string | null),
    checks: Array.isArray(payload.checks)
      ? (payload.checks as RigVersion["checks"])
      : baseVersion.checks,
    credentialHooks: Array.isArray(payload.credentialHooks)
      ? (payload.credentialHooks as string[])
      : baseVersion.credentialHooks,
    defaultVariableSetIds: Array.isArray(payload.defaultVariableSetIds)
      ? (payload.defaultVariableSetIds as string[])
      : baseVersion.defaultVariableSetIds,
    changelog: typeof payload.changelog === "string" ? payload.changelog : baseVersion.changelog,
  };
}

async function loadChangeTarget(
  db: Database,
  workspaceId: string,
  changeId: string,
): Promise<{ rig: Rig; baseVersion: RigVersion; change: RigChange }> {
  const change = await getRigChange(db, workspaceId, changeId);
  if (!change) {
    throw new Error(`Rig change not found: ${changeId}`);
  }
  const rig = await getRig(db, workspaceId, change.rigId);
  if (!rig) {
    throw new Error(`Rig not found for change: ${change.rigId}`);
  }
  if (!change.baseVersionId) {
    throw new Error(`Rig change ${change.id} has no base version`);
  }
  const baseVersion = await getRigVersionById(db, workspaceId, change.baseVersionId);
  if (!baseVersion || baseVersion.rigId !== rig.id) {
    throw new Error(`Base rig version not found: ${change.baseVersionId}`);
  }
  return { rig, baseVersion, change };
}

async function loadVersionTarget(
  db: Database,
  workspaceId: string,
  versionId: string,
): Promise<{ rig: Rig; version: RigVersion }> {
  const version = await getRigVersionById(db, workspaceId, versionId);
  if (!version) {
    throw new Error(`Rig version not found: ${versionId}`);
  }
  const rig = await getRig(db, workspaceId, version.rigId);
  if (!rig) {
    throw new Error(`Rig not found for version: ${version.rigId}`);
  }
  return { rig, version };
}

export function createRigVerificationActivities(services: () => Promise<ActivityServices>) {
  return {
    verifyRigChange: async (input: { workspaceId: string; changeId: string }) => {
      const { settings, db, observability } = await services();
      const { rig, baseVersion, change } = await loadChangeTarget(
        db,
        input.workspaceId,
        input.changeId,
      );
      const grant = systemGrant(rig);
      const startedAt = new Date().toISOString();
      await beginRigChangeVerificationAttempt(db, input.workspaceId, change.id, {
        startedAt,
        allowAlreadyVerifying: true,
      });
      await recordRigAuditEvent(db, {
        grant,
        action: "rig.verification.started",
        rigId: rig.id,
        metadata: { changeId: change.id },
      });

      const verification: Record<string, unknown> = { startedAt, checkResults: [] };
      try {
        const candidateVersion = candidateVersionForChange(baseVersion, change);
        const runSettings = settingsWithRigImage(settings, candidateVersion.image);
        return await runWithOwnedRigVerificationSandbox(
          {
            settings: runSettings,
            db,
            observability,
            accountId: rig.accountId,
            workspaceId: input.workspaceId,
            sessionIdPrefix: `rig-verification-${change.id}`,
          },
          async (established) => {
            if ((candidateVersion.setupScript ?? "").trim()) {
              await runRigSetupHook(established.session as never, {
                environment: {},
                runAs: "root",
                rigSetup: {
                  rigId: rig.id,
                  rigName: rig.name,
                  versionId: candidateVersion.id,
                  script: candidateVersion.setupScript ?? "",
                  timeoutMs: settings.rigSetupTimeoutMs,
                },
              });
              verification.setupResult = { exitCode: 0, output: "" };
            }
            const command = setupAppendCommand(change);
            if (command) {
              const commandResult = await runCommand(
                established.session as CommandSession,
                command,
                settings.rigSetupTimeoutMs,
              );
              verification.commandResult = commandResult;
              if (commandResult.exitCode !== 0) {
                verification.finishedAt = new Date().toISOString();
                verification.passed = false;
                const updated = await updateRigChangeStatus(db, input.workspaceId, change.id, {
                  status: "rejected",
                  verification: scrubVerificationPayload(verification),
                });
                await recordRigAuditEvent(db, {
                  grant,
                  action: "rig.verification.failed",
                  rigId: rig.id,
                  metadata: { changeId: change.id, status: "rejected" },
                });
                await recordRigAuditEvent(db, {
                  grant,
                  action: "rig.change.rejected",
                  rigId: rig.id,
                  metadata: { changeId: change.id },
                });
                return updated;
              }
            }
            const checkResults = [];
            for (const check of candidateVersion.checks) {
              const result = await runCommand(
                established.session as CommandSession,
                check.command,
                settings.rigSetupTimeoutMs,
              );
              checkResults.push({
                name: check.name,
                command: scrubVerificationOutput(check.command),
                ...result,
              });
            }
            verification.checkResults = checkResults;
            const passed = checkResults.every((result) => result.exitCode === 0);
            verification.finishedAt = new Date().toISOString();
            verification.passed = passed;
            const classified = classifyRigVerificationOutcome({ kind: change.kind, passed });
            if (classified.action === "auto_promote") {
              // Keep the change `verifying` (NOT `proposed`) across the write→promote
              // gap: promoteSetupAppendChange accepts `verifying`, and leaving it
              // `verifying` keeps beginRigChangeVerificationAttempt blocking a
              // concurrent /verify — resetting to `proposed` would reopen that race
              // (a second run could reject a change whose first verification passed).
              await updateRigChangeStatus(db, input.workspaceId, change.id, {
                status: "verifying",
                verification: scrubVerificationPayload(verification),
              });
              const { change: merged } = await promoteSetupAppendChange({ db }, grant, rig, {
                ...change,
                verification,
              });
              await recordRigAuditEvent(db, {
                grant,
                action: "rig.verification.passed",
                rigId: rig.id,
                metadata: { changeId: change.id },
              });
              return merged;
            }
            const updated = await updateRigChangeStatus(db, input.workspaceId, change.id, {
              status: classified.status,
              verification: scrubVerificationPayload(verification),
            });
            await recordRigAuditEvent(db, {
              grant,
              action: passed ? "rig.verification.passed" : "rig.verification.failed",
              rigId: rig.id,
              metadata: { changeId: change.id, status: classified.status },
            });
            if (!passed) {
              await recordRigAuditEvent(db, {
                grant,
                action: "rig.change.rejected",
                rigId: rig.id,
                metadata: { changeId: change.id },
              });
            }
            return updated;
          },
        );
      } catch (error) {
        verification.finishedAt = new Date().toISOString();
        verification.passed = false;
        verification.error = scrubVerificationOutput(
          error instanceof Error ? error.message : String(error),
        );
        const updated = await updateRigChangeStatus(db, input.workspaceId, change.id, {
          status: "failed",
          verification: scrubVerificationPayload(verification),
        });
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.verification.failed",
          rigId: rig.id,
          metadata: { changeId: change.id, status: "failed" },
        });
        await recordRigAuditEvent(db, {
          grant,
          action: "rig.change.failed",
          rigId: rig.id,
          metadata: { changeId: change.id },
        });
        return updated;
      }
    },

    verifyRigVersion: async (input: { workspaceId: string; versionId: string }) => {
      const { settings, db, observability } = await services();
      const { rig, version } = await loadVersionTarget(db, input.workspaceId, input.versionId);
      const grant = systemGrant(rig);
      const startedAt = new Date().toISOString();
      await recordRigAuditEvent(db, {
        grant,
        action: "rig.verification.started",
        rigId: rig.id,
        metadata: { versionId: version.id },
      });
      try {
        const runSettings = settingsWithRigImage(settings, version.image);
        return await runWithOwnedRigVerificationSandbox(
          {
            settings: runSettings,
            db,
            observability,
            accountId: rig.accountId,
            workspaceId: input.workspaceId,
            sessionIdPrefix: `rig-version-verification-${version.id}`,
          },
          async (established) => {
            if ((version.setupScript ?? "").trim()) {
              await runRigSetupHook(established.session as never, {
                environment: {},
                runAs: "root",
                rigSetup: {
                  rigId: rig.id,
                  rigName: rig.name,
                  versionId: version.id,
                  script: version.setupScript ?? "",
                  timeoutMs: settings.rigSetupTimeoutMs,
                },
              });
            }
            const checkResults = [];
            for (const check of version.checks) {
              checkResults.push({
                name: check.name,
                command: scrubVerificationOutput(check.command),
                ...(await runCommand(
                  established.session as CommandSession,
                  check.command,
                  settings.rigSetupTimeoutMs,
                )),
              });
            }
            const passed = checkResults.every((result) => result.exitCode === 0);
            await recordRigAuditEvent(db, {
              grant,
              action: passed ? "rig.verification.passed" : "rig.verification.failed",
              rigId: rig.id,
              metadata: scrubVerificationPayload({
                versionId: version.id,
                startedAt,
                finishedAt: new Date().toISOString(),
                passed,
                checkResults,
              }),
            });
            return { versionId: version.id, passed, checkResults };
          },
        );
      } catch (error) {
        // Infra failure (sandbox establish / setup / check exec threw) — record
        // rig.verification.failed so activeVersionHealth reflects the failed
        // re-run instead of staying stale, symmetric to verifyRigChange. Then
        // rethrow so the Temporal activity still surfaces the failure.
        const detail = tail(
          scrubVerificationOutput(error instanceof Error ? error.message : String(error)),
          4096,
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
        throw error;
      }
    },
  };
}
