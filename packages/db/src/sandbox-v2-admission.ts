import {
  initialSandboxMachine,
  selectSandboxEngine,
  workspaceSandboxV2Enabled,
  type SandboxEngine,
} from "@opengeni/contracts";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "./database";
import { sandboxLeases, sessions } from "./schema";
import { sandboxGroupEngines, sandboxV2Machines } from "./sandbox-v2-schema";
import { insertSandboxMachineInTransaction } from "./sandbox-v2-machines";

export type SandboxV2AdmissionPolicy = {
  enabled: boolean;
  qualifiedBackends: ReadonlySet<string>;
};
const policies = new WeakMap<Database, SandboxV2AdmissionPolicy>();

/** Installed by trusted host composition, never by a session-create argument.
 * Each database service has its own default-off policy; hosts can coexist. */
export function configureSandboxV2AdmissionPolicy(
  db: Database,
  policy: SandboxV2AdmissionPolicy,
): void {
  policies.set(db, {
    enabled: policy.enabled === true,
    qualifiedBackends: new Set(policy.qualifiedBackends),
  });
}
export function sandboxV2AdmissionPolicyForCreate(db: Database): SandboxV2AdmissionPolicy {
  const policy = policies.get(db);
  return {
    enabled: policy?.enabled === true,
    qualifiedBackends: new Set(policy?.qualifiedBackends),
  };
}

/** Run only for a winning fresh session inside its existing tenant/workspace
 * control transaction. No provider I/O. Replay never reaches this function. */
export async function admitSandboxEngineForNewSession(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    sandboxGroupId: string;
    joinsExistingGroup: boolean;
    backend: string;
    workspaceSettings: unknown;
  },
  policy: SandboxV2AdmissionPolicy,
): Promise<SandboxEngine> {
  const [claim] = await tx
    .select({ engine: sandboxGroupEngines.engine })
    .from(sandboxGroupEngines)
    .where(
      and(
        eq(sandboxGroupEngines.accountId, input.accountId),
        eq(sandboxGroupEngines.workspaceId, input.workspaceId),
        eq(sandboxGroupEngines.sandboxGroupId, input.sandboxGroupId),
      ),
    )
    .limit(1);
  if (claim) return claim.engine;
  const [recorded] = await tx
    .select({ id: sandboxV2Machines.id })
    .from(sandboxV2Machines)
    .where(
      and(
        eq(sandboxV2Machines.accountId, input.accountId),
        eq(sandboxV2Machines.workspaceId, input.workspaceId),
        eq(sandboxV2Machines.sandboxGroupId, input.sandboxGroupId),
      ),
    )
    .limit(1);
  if (recorded) return "machine-v2";
  // Explicit joins inherit absence as legacy. Do not interpret a new flag as
  // permission to change an already-existing shared group's implementation.
  async function claimLegacy(): Promise<SandboxEngine> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      ${`sandbox-lease-admission:${input.workspaceId}:${input.sandboxGroupId}`}, 0))`);
    await tx
      .insert(sandboxGroupEngines)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sandboxGroupId: input.sandboxGroupId,
        engine: "legacy",
      })
      .onConflictDoNothing();
    const [saved] = await tx
      .select({ engine: sandboxGroupEngines.engine })
      .from(sandboxGroupEngines)
      .where(
        and(
          eq(sandboxGroupEngines.accountId, input.accountId),
          eq(sandboxGroupEngines.workspaceId, input.workspaceId),
          eq(sandboxGroupEngines.sandboxGroupId, input.sandboxGroupId),
        ),
      )
      .limit(1);
    if (!saved) throw new Error("Sandbox engine claim unavailable");
    return saved.engine;
  }
  if (input.joinsExistingGroup) return claimLegacy();
  if (
    selectSandboxEngine({
      deploymentEnabled: policy.enabled,
      workspaceEnabled: workspaceSandboxV2Enabled(input.workspaceSettings),
      recorded: null,
      isNewGroup: true,
      backend: input.backend,
      qualifiedBackends: policy.qualifiedBackends,
    }) === "legacy"
  )
    return claimLegacy();
  // Share the absent-row fence with legacy admission. A retained cold lease is
  // still legacy authority even if its last session has been deleted.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${`sandbox-lease-admission:${input.workspaceId}:${input.sandboxGroupId}`}, 0))`);
  const [legacy] = await tx
    .select({ id: sandboxLeases.sandboxGroupId })
    .from(sandboxLeases)
    .where(
      and(
        eq(sandboxLeases.accountId, input.accountId),
        eq(sandboxLeases.workspaceId, input.workspaceId),
        eq(sandboxLeases.sandboxGroupId, input.sandboxGroupId),
      ),
    )
    .limit(1);
  const [sibling] = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.accountId, input.accountId),
        eq(sessions.workspaceId, input.workspaceId),
        eq(sessions.sandboxGroupId, input.sandboxGroupId),
        ne(sessions.id, input.sessionId),
      ),
    )
    .limit(1);
  const engine = selectSandboxEngine({
    deploymentEnabled: policy.enabled,
    workspaceEnabled: workspaceSandboxV2Enabled(input.workspaceSettings),
    recorded: null,
    isNewGroup: !sibling && !legacy,
    backend: input.backend,
    qualifiedBackends: policy.qualifiedBackends,
  });
  if (engine === "machine-v2")
    await insertSandboxMachineInTransaction(
      tx,
      input.accountId,
      initialSandboxMachine(
        { workspaceId: input.workspaceId, sandboxGroupId: input.sandboxGroupId },
        input.backend,
        crypto.randomUUID(),
      ),
    );
  return engine === "legacy" ? claimLegacy() : engine;
}
