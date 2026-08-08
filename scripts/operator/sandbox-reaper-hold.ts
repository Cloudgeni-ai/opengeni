import { dbSearchPath, getSettings } from "@opengeni/config";
import {
  acquireSandboxLeaseReaperHold,
  createDb,
  readSandboxLeaseReaperHoldTarget,
  releaseSandboxLeaseReaperHold,
  SANDBOX_REAPER_HOLD_MAX_TTL_MS,
  type Database,
  type LeaseSnapshot,
} from "@opengeni/db";

export type SandboxReaperHoldMode = "preview" | "acquire" | "release";

export type SandboxReaperHoldInput = {
  mode: SandboxReaperHoldMode;
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  expectedEpoch: number;
  expectedInstanceId: string;
  holdId: string;
  ttlMs?: number;
  reason?: string;
};

export type SandboxReaperHoldDependencies = {
  openDatabase: () => { db: Database; close: () => Promise<void> };
  read: typeof readSandboxLeaseReaperHoldTarget;
  acquire: typeof acquireSandboxLeaseReaperHold;
  release: typeof releaseSandboxLeaseReaperHold;
  providerDeadlineHeadroomMs: () => number;
  output: (line: string) => void;
};

const defaultDependencies: SandboxReaperHoldDependencies = {
  openDatabase: () => {
    const settings = getSettings();
    const searchPath = dbSearchPath(settings);
    const client = createDb(settings.databaseUrl, {
      ...(searchPath ? { searchPath } : {}),
      rlsStrategy: settings.rlsStrategy,
      max: 1,
    });
    return { db: client.db, close: async () => await client.close() };
  },
  read: readSandboxLeaseReaperHoldTarget,
  acquire: acquireSandboxLeaseReaperHold,
  release: releaseSandboxLeaseReaperHold,
  providerDeadlineHeadroomMs: () => getSettings().sandboxRotationLeadMs,
  output: (line) => console.log(line),
};

export function sandboxReaperHoldInput(env: NodeJS.ProcessEnv): SandboxReaperHoldInput {
  const mode = required(env, "OPENGENI_SANDBOX_REAPER_HOLD");
  if (mode !== "preview" && mode !== "acquire" && mode !== "release") {
    throw new Error("OPENGENI_SANDBOX_REAPER_HOLD must be exactly preview, acquire, or release");
  }
  const input: SandboxReaperHoldInput = {
    mode,
    accountId: uuid(env, "OPENGENI_SANDBOX_REAPER_HOLD_ACCOUNT_ID"),
    workspaceId: uuid(env, "OPENGENI_SANDBOX_REAPER_HOLD_WORKSPACE_ID"),
    sandboxGroupId: uuid(env, "OPENGENI_SANDBOX_REAPER_HOLD_GROUP_ID"),
    expectedEpoch: nonnegativeInteger(env, "OPENGENI_SANDBOX_REAPER_HOLD_EPOCH"),
    expectedInstanceId: bounded(env, "OPENGENI_SANDBOX_REAPER_HOLD_INSTANCE_ID", 512),
    holdId: uuid(env, "OPENGENI_SANDBOX_REAPER_HOLD_ID"),
  };
  if (mode === "acquire") {
    const ttlMs = positiveInteger(env, "OPENGENI_SANDBOX_REAPER_HOLD_TTL_MS");
    if (ttlMs > SANDBOX_REAPER_HOLD_MAX_TTL_MS) {
      throw new Error("OPENGENI_SANDBOX_REAPER_HOLD_TTL_MS must not exceed 24 hours");
    }
    input.ttlMs = ttlMs;
    input.reason = bounded(env, "OPENGENI_SANDBOX_REAPER_HOLD_REASON", 500);
  }
  return input;
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: SandboxReaperHoldDependencies = defaultDependencies,
): Promise<number> {
  const input = sandboxReaperHoldInput(env);
  const client = dependencies.openDatabase();
  try {
    if (input.mode === "preview") {
      const lease = await dependencies.read(client.db, input);
      const exact =
        lease !== null &&
        lease.leaseEpoch === input.expectedEpoch &&
        lease.instanceId === input.expectedInstanceId;
      dependencies.output(
        `OPENGENI_SANDBOX_REAPER_HOLD_PREVIEW=${JSON.stringify({
          status: lease === null ? "not_found" : exact ? "exact" : "fenced",
          requestedHoldId: input.holdId,
          lease: projectLease(lease),
        })}`,
      );
      return exact ? 0 : 2;
    }

    if (input.mode === "acquire") {
      const result = await dependencies.acquire(client.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sandboxGroupId: input.sandboxGroupId,
        expectedEpoch: input.expectedEpoch,
        expectedInstanceId: input.expectedInstanceId,
        holdId: input.holdId,
        ttlMs: input.ttlMs!,
        providerDeadlineHeadroomMs: dependencies.providerDeadlineHeadroomMs(),
        reason: input.reason!,
      });
      dependencies.output(
        `OPENGENI_SANDBOX_REAPER_HOLD_RESULT=${JSON.stringify({
          status: result.status,
          holdId: input.holdId,
          ...(result.status === "held" ? { renewed: result.renewed } : {}),
          lease: projectLease(result.lease),
        })}`,
      );
      return result.status === "held" ? 0 : 2;
    }

    const released = await dependencies.release(client.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxGroupId,
      expectedEpoch: input.expectedEpoch,
      expectedInstanceId: input.expectedInstanceId,
      holdId: input.holdId,
    });
    dependencies.output(
      `OPENGENI_SANDBOX_REAPER_HOLD_RELEASE=${JSON.stringify({
        status: released ? "released" : "fenced",
        holdId: input.holdId,
      })}`,
    );
    return released ? 0 : 2;
  } finally {
    await client.close();
  }
}

function projectLease(lease: LeaseSnapshot | null): Record<string, unknown> | null {
  if (!lease) return null;
  return {
    id: lease.id,
    sandboxGroupId: lease.sandboxGroupId,
    backend: lease.backend,
    liveness: lease.liveness,
    leaseEpoch: lease.leaseEpoch,
    instanceId: lease.instanceId,
    refcount: lease.refcount,
    turnHolders: lease.turnHolders,
    viewerHolders: lease.viewerHolders,
    expiresAt: lease.expiresAt,
    providerDeadlineAt: lease.providerDeadlineAt,
    rotationRequestedAt: lease.rotationRequestedAt,
    rotationReason: lease.rotationReason,
    archiveCapture: lease.archiveCapture,
    reaperHold: lease.reaperHold,
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bounded(env: NodeJS.ProcessEnv, name: string, max: number): string {
  const value = required(env, name);
  if (value.length > max) throw new Error(`${name} must contain 1-${max} characters`);
  return value;
}

function uuid(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`${name} must be a canonical lowercase UUID`);
  }
  return value;
}

function nonnegativeInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

if (import.meta.main) {
  process.exitCode = await main();
}
