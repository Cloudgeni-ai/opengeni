import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  SandboxV2PreparationPlan,
  ResourceRef,
  assertUniqueResourceMountPaths,
  type FileResourceRef,
} from "@opengeni/contracts";
import type { Database } from "./database";
import {
  withSandboxV2TurnMachineFence,
  type SandboxJournalControlAuthority,
} from "./sandbox-v2-commands";
import { sandboxV2PreparationPlans } from "./sandbox-v2-schema";
import { sessions, sessionTurns } from "./schema";

export class SandboxV2PreparationPlanError extends Error {
  readonly code = "SANDBOX_V2_PREPARATION_PLAN";
}
function fail(): never {
  throw new SandboxV2PreparationPlanError("Retained native preparation plan or authority changed");
}
function parse(input: unknown): SandboxV2PreparationPlan {
  const result = SandboxV2PreparationPlan.safeParse(input);
  if (!result.success) fail();
  // JSON persistence omits optional undefined fields. Canonicalize before both
  // hashing and comparison so a replacement observer sees the original plan.
  return JSON.parse(JSON.stringify(result.data)) as SandboxV2PreparationPlan;
}
function digest(plan: SandboxV2PreparationPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}
function scope(context: SandboxJournalControlAuthority, setupId: string) {
  return and(
    eq(sandboxV2PreparationPlans.accountId, context.accountId),
    eq(sandboxV2PreparationPlans.workspaceId, context.workspaceId),
    eq(sandboxV2PreparationPlans.sessionId, context.sessionId),
    eq(sandboxV2PreparationPlans.turnId, context.turnId),
    eq(sandboxV2PreparationPlans.setupId, setupId),
  );
}
function retained(
  row: typeof sandboxV2PreparationPlans.$inferSelect,
  context: SandboxJournalControlAuthority,
): SandboxV2PreparationPlan {
  if (
    row.attemptId !== context.attemptId ||
    row.executionGeneration !== context.executionGeneration ||
    row.machineId !== context.machineId ||
    !isDeepStrictEqual(row.instance, context.instance)
  )
    fail();
  const plan = parse(row.definition);
  if (plan.setupId !== row.setupId || digest(plan) !== row.definitionDigest) fail();
  return plan;
}

/** Resolve only the canonical current turn's attachments under its live native
 * attempt/incarnation fence. Historical session attachments are not setup
 * inputs. The causal-human selector grants nothing by itself; callers must use
 * the ordinary file owner/provider ACL before metadata or URL delivery. */
export async function loadSandboxV2TurnFileResources(
  db: Database,
  authority: SandboxJournalControlAuthority,
): Promise<{ resources: FileResourceRef[]; initiatingHumanSubjectId: string | null }> {
  const inputs = await loadSandboxV2TurnResourceInputs(db, authority);
  const resources = inputs.turnResources.filter(
    (resource): resource is FileResourceRef => resource.kind === "file",
  );
  if (new Set(resources.map((resource) => resource.fileId)).size !== resources.length) fail();
  return { resources, initiatingHumanSubjectId: inputs.initiatingHumanSubjectId };
}

/** Canonical original inputs, not caller-supplied setup authority. Session
 * repositories remain ordinary inputs; only current-turn files are delivered. */
export async function loadSandboxV2TurnResourceInputs(
  db: Database,
  authority: SandboxJournalControlAuthority,
) {
  const context = structuredClone(authority);
  return withSandboxV2TurnMachineFence(db, context, async (tx) => {
    const [turn] = await tx
      .select({
        resources: sessionTurns.resources,
        sessionResources: sessions.resources,
        initiatingHumanSubjectId: sessionTurns.initiatingHumanSubjectId,
      })
      .from(sessionTurns)
      .innerJoin(sessions, eq(sessions.id, sessionTurns.sessionId))
      .where(
        and(
          eq(sessionTurns.accountId, context.accountId),
          eq(sessionTurns.workspaceId, context.workspaceId),
          eq(sessionTurns.sessionId, context.sessionId),
          eq(sessionTurns.id, context.turnId),
        ),
      )
      .limit(1);
    if (!turn) fail();
    const parsed = ResourceRef.array().max(1024).safeParse(turn.resources);
    const sessionResources = ResourceRef.array().max(1024).safeParse(turn.sessionResources);
    if (!parsed.success || !sessionResources.success) fail();
    assertUniqueResourceMountPaths(parsed.data);
    return {
      turnResources: parsed.data,
      sessionResources: sessionResources.data,
      initiatingHumanSubjectId: turn.initiatingHumanSubjectId,
    };
  });
}

/** Read under the active exact attempt/incarnation fence. A host must recover
 * this original plan before resolving a replacement activity's setup inputs.
 * Cross-attempt adoption is separate; this read grants no launch authority. */
export async function loadSandboxV2PreparationPlan(
  db: Database,
  authority: SandboxJournalControlAuthority,
  setupId: string,
): Promise<SandboxV2PreparationPlan | null> {
  const context = structuredClone(authority);
  if (typeof setupId !== "string" || !setupId || setupId.length > 512 || setupId.includes("\0"))
    fail();
  return withSandboxV2TurnMachineFence(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(sandboxV2PreparationPlans)
      .where(scope(context, setupId))
      .limit(1);
    return row ? retained(row, context) : null;
  });
}

/** Retain the complete host plan before any command, credential resolution or
 * file URL minting. Same-attempt replay returns its original definition;
 * conflicting definitions fail. No model tool receipt or guest command is
 * fabricated. Credential-generation references must remain host-recoverable. */
export async function retainSandboxV2PreparationPlan(
  db: Database,
  authority: SandboxJournalControlAuthority,
  input: SandboxV2PreparationPlan,
): Promise<SandboxV2PreparationPlan> {
  const context = structuredClone(authority);
  const plan = parse(structuredClone(input));
  return withSandboxV2TurnMachineFence(db, context, async (tx) => {
    const [prior] = await tx
      .select()
      .from(sandboxV2PreparationPlans)
      .where(scope(context, plan.setupId))
      .limit(1);
    if (prior) {
      const original = retained(prior, context);
      if (!isDeepStrictEqual(original, plan)) fail();
      return original;
    }
    const [saved] = await tx
      .insert(sandboxV2PreparationPlans)
      .values({
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        turnId: context.turnId,
        executionGeneration: context.executionGeneration,
        attemptId: context.attemptId,
        machineId: context.machineId,
        instance: context.instance,
        setupId: plan.setupId,
        definition: plan,
        definitionDigest: digest(plan),
      })
      .returning();
    if (!saved) fail();
    return retained(saved, context);
  });
}
