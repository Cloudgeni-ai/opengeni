import type { AccessGrant, Rig, RigChange, RigVersion } from "@opengeni/contracts";
import {
  recordRigAuditEvent,
  classifyRigVerificationOutcome,
  promoteSetupAppendChange,
} from "@opengeni/core";
import { getRig, getRigChange, getRigVersionById, updateRigChangeStatus, type Database } from "@opengeni/db";
import {
  establishSandboxSessionFromEnvelope,
  runRigSetupHook,
  sandboxCommandExitCode,
  sandboxCommandOutput,
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

function tail(value: string, limit = OUTPUT_TAIL_LIMIT): string {
  return value.length > limit ? value.slice(-limit) : value;
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
    await client.delete(established.sessionState).catch(() => undefined);
    return;
  }
  const session = established.session as { terminate?: () => Promise<unknown>; kill?: () => Promise<unknown>; close?: () => Promise<unknown>; closed?: boolean };
  if (session.terminate) {
    await session.terminate().catch(() => undefined);
  } else if (session.kill) {
    await session.kill().catch(() => undefined);
  } else if (session.close && !session.closed) {
    await session.close().catch(() => undefined);
  }
}

async function runCommand(session: CommandSession, command: string, timeoutMs: number): Promise<CommandResult> {
  const args = {
    cmd: command,
    workdir: "/workspace",
    yieldTimeMs: timeoutMs,
    maxOutputTokens: 40_000,
  };
  const result = session.exec
    ? await session.exec(args)
    : session.execCommand
      ? await session.execCommand(args)
      : (() => { throw new Error("Sandbox session does not support command execution"); })();
  return {
    exitCode: sandboxCommandExitCode(result),
    output: tail(sandboxCommandOutput(result)),
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
    setupScript: payload.setupScript === undefined ? baseVersion.setupScript : (payload.setupScript as string | null),
    checks: Array.isArray(payload.checks) ? payload.checks as RigVersion["checks"] : baseVersion.checks,
    credentialHooks: Array.isArray(payload.credentialHooks) ? payload.credentialHooks as string[] : baseVersion.credentialHooks,
    defaultVariableSetIds: Array.isArray(payload.defaultVariableSetIds) ? payload.defaultVariableSetIds as string[] : baseVersion.defaultVariableSetIds,
    changelog: typeof payload.changelog === "string" ? payload.changelog : baseVersion.changelog,
  };
}

async function loadChangeTarget(db: Database, workspaceId: string, changeId: string): Promise<{ rig: Rig; baseVersion: RigVersion; change: RigChange }> {
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

async function loadVersionTarget(db: Database, workspaceId: string, versionId: string): Promise<{ rig: Rig; version: RigVersion }> {
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
      const { settings, db } = await services();
      const { rig, baseVersion, change } = await loadChangeTarget(db, input.workspaceId, input.changeId);
      const grant = systemGrant(rig);
      const startedAt = new Date().toISOString();
      await updateRigChangeStatus(db, input.workspaceId, change.id, {
        status: "verifying",
        verification: { startedAt, checkResults: [] },
      });
      await recordRigAuditEvent(db, { grant, action: "rig.verification.started", rigId: rig.id, metadata: { changeId: change.id } });

      let established: EstablishedSandboxSession | null = null;
      const verification: Record<string, unknown> = { startedAt, checkResults: [] };
      try {
        const candidateVersion = candidateVersionForChange(baseVersion, change);
        const runSettings = settingsWithRigImage(settings, candidateVersion.image);
        established = await establishSandboxSessionFromEnvelope(runSettings, null, {
          sessionId: `rig-verification-${change.id}`,
          environment: {},
        });
        if ((candidateVersion.setupScript ?? "").trim()) {
          await runRigSetupHook(established.session as never, {
            environment: {},
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
          const commandResult = await runCommand(established.session as CommandSession, command, settings.rigSetupTimeoutMs);
          verification.commandResult = commandResult;
          if (commandResult.exitCode !== 0) {
            verification.finishedAt = new Date().toISOString();
            verification.passed = false;
            const updated = await updateRigChangeStatus(db, input.workspaceId, change.id, {
              status: "rejected",
              verification,
            });
            await recordRigAuditEvent(db, { grant, action: "rig.verification.failed", rigId: rig.id, metadata: { changeId: change.id, status: "rejected" } });
            await recordRigAuditEvent(db, { grant, action: "rig.change.rejected", rigId: rig.id, metadata: { changeId: change.id } });
            return updated;
          }
        }
        const checkResults = [];
        for (const check of candidateVersion.checks) {
          const result = await runCommand(established.session as CommandSession, check.command, settings.rigSetupTimeoutMs);
          checkResults.push({ name: check.name, command: check.command, ...result });
        }
        verification.checkResults = checkResults;
        const passed = checkResults.every((result) => result.exitCode === 0);
        verification.finishedAt = new Date().toISOString();
        verification.passed = passed;
        const classified = classifyRigVerificationOutcome({ kind: change.kind, passed });
        if (classified.action === "auto_promote") {
          await updateRigChangeStatus(db, input.workspaceId, change.id, { status: "proposed", verification });
          const { change: merged } = await promoteSetupAppendChange({ db }, grant, rig, { ...change, verification });
          await recordRigAuditEvent(db, { grant, action: "rig.verification.passed", rigId: rig.id, metadata: { changeId: change.id } });
          return merged;
        }
        const updated = await updateRigChangeStatus(db, input.workspaceId, change.id, {
          status: classified.status,
          verification,
        });
        await recordRigAuditEvent(db, {
          grant,
          action: passed ? "rig.verification.passed" : "rig.verification.failed",
          rigId: rig.id,
          metadata: { changeId: change.id, status: classified.status },
        });
        if (!passed) {
          await recordRigAuditEvent(db, { grant, action: "rig.change.rejected", rigId: rig.id, metadata: { changeId: change.id } });
        }
        return updated;
      } catch (error) {
        verification.finishedAt = new Date().toISOString();
        verification.passed = false;
        verification.error = error instanceof Error ? error.message : String(error);
        const updated = await updateRigChangeStatus(db, input.workspaceId, change.id, {
          status: "failed",
          verification,
        });
        await recordRigAuditEvent(db, { grant, action: "rig.verification.failed", rigId: rig.id, metadata: { changeId: change.id, status: "failed" } });
        await recordRigAuditEvent(db, { grant, action: "rig.change.failed", rigId: rig.id, metadata: { changeId: change.id } });
        return updated;
      } finally {
        await terminateThrowaway(established);
      }
    },

    verifyRigVersion: async (input: { workspaceId: string; versionId: string }) => {
      const { settings, db } = await services();
      const { rig, version } = await loadVersionTarget(db, input.workspaceId, input.versionId);
      const grant = systemGrant(rig);
      const startedAt = new Date().toISOString();
      await recordRigAuditEvent(db, { grant, action: "rig.verification.started", rigId: rig.id, metadata: { versionId: version.id } });
      let established: EstablishedSandboxSession | null = null;
      try {
        const runSettings = settingsWithRigImage(settings, version.image);
        established = await establishSandboxSessionFromEnvelope(runSettings, null, {
          sessionId: `rig-version-verification-${version.id}`,
          environment: {},
        });
        if ((version.setupScript ?? "").trim()) {
          await runRigSetupHook(established.session as never, {
            environment: {},
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
          checkResults.push({ name: check.name, command: check.command, ...(await runCommand(established.session as CommandSession, check.command, settings.rigSetupTimeoutMs)) });
        }
        const passed = checkResults.every((result) => result.exitCode === 0);
        await recordRigAuditEvent(db, {
          grant,
          action: passed ? "rig.verification.passed" : "rig.verification.failed",
          rigId: rig.id,
          metadata: { versionId: version.id, startedAt, finishedAt: new Date().toISOString(), passed, checkResults },
        });
        return { versionId: version.id, passed, checkResults };
      } finally {
        await terminateThrowaway(established);
      }
    },
  };
}
