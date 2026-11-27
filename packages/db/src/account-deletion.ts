import { AccountDeletionPreview, AccountDeletionRequest } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { rawRows, withWorkspaceSessionActivityRls, type Database } from "./database";
import { updateOrganizationMember } from "./organization-membership-lifecycle";
import { revokePersonalApiKeysForOwner } from "./personal-api-keys";
import { nestedPostgresSqlState } from "./persistence-errors";
import {
  lockWorkspaceInferenceControl,
  mutateSessionControlInTransaction,
} from "./session-control";

const entry = z.object({
  organizationId: z.uuid(),
  membershipId: z.uuid(),
  revision: z.number().int().positive(),
  kind: z.enum(["close", "leave", "block", "revoked"]),
  retention: z.object({
    mode: z.enum(["retain", "delete_after"]),
    days: z.number().int().nullable(),
  }),
});
const result = z.object({
  plan: z.array(entry.extend({ name: z.string() })).optional(),
  request: AccountDeletionRequest.optional(),
});
export const AccountDeletionWork = z.object({
  id: z.uuid(),
  authUserId: z.string(),
  subjectId: z.string(),
  email: z.string().nullable(),
  status: AccountDeletionRequest.shape.status,
  plan: z.array(entry),
  progress: z.record(z.string(), z.literal(true)),
  terminalFailure: z.boolean(),
  stalledSince: z.iso.datetime({ offset: true }).nullable(),
  blockedStep: z.string().nullable(),
});

export type AccountDeletionActor = { authUserId: string; authSessionId: string };

export async function accountDeletionAvailable(db: Database): Promise<boolean> {
  const [row] = await rawRows<{ available: boolean }>(
    db,
    sql`
    select has_function_privilege(to_regprocedure('opengeni_private.account_deletion_user_v1(text,jsonb)'), 'EXECUTE')
       and has_function_privilege(to_regprocedure('opengeni_private.account_deletion_work_v1(text,jsonb)'), 'EXECUTE') as available
  `,
  );
  return row?.available === true;
}

async function userAction(
  db: Database,
  action: "preview" | "start" | "seal",
  args: AccountDeletionActor,
) {
  const [row] = await rawRows<{ value: unknown }>(
    db,
    sql`
    select opengeni_private.account_deletion_user_v1(${action}, ${JSON.stringify(args)}::jsonb) as value
  `,
  );
  return result.parse(row?.value);
}

function publicPlan(value: z.infer<typeof result>): AccountDeletionPreview {
  const plan = value.plan ?? [];
  return AccountDeletionPreview.parse({
    closeOrganizations: plan.filter((org) => org.kind === "close"),
    leaveOrganizations: plan.filter((org) => org.kind === "leave"),
    blockers: plan
      .filter((org) => org.kind === "block")
      .map((org) => ({
        ...org,
        code: "LAST_ORGANIZATION_OWNER",
      })),
    request: value.request ?? null,
  });
}

export async function previewAccountDeletion(db: Database, actor: AccountDeletionActor) {
  return publicPlan(await userAction(db, "preview", actor));
}

/** Plan, offboard and revoke in one transaction. A rejected or rolled-back
 * request never leaves partial membership changes or signs anybody out. */
export async function startAccountDeletion(
  db: Database,
  input: AccountDeletionActor & { operationId: string; actorMutationRequestId?: string },
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (txHandle) => {
        const tx = txHandle as unknown as Database;
        const admission = await userAction(tx, "start", input);
        if (!admission.plan || !admission.request) return publicPlan(admission);
        for (const org of admission.plan) {
          const actorSubjectId = `user:${input.authUserId}`;
          if (org.kind === "revoked") {
            await revokePersonalApiKeysForOwner(tx, {
              accountId: org.organizationId,
              ownerSubjectId: actorSubjectId,
            });
          } else {
            await updateOrganizationMember(tx, {
              actorSubjectId,
              membershipId: org.membershipId,
              organizationId: org.organizationId,
              operationId: admission.request.id,
              transition: { kind: "leave", expectedAuthorizationRevision: org.revision },
            });
          }
        }
        if (input.actorMutationRequestId) {
          await tx.execute(
            sql`select set_config('opengeni.managed_auth_actor_mutation_request_id', ${input.actorMutationRequestId}, true)`,
          );
        }
        return publicPlan(await userAction(tx, "seal", input));
      });
    } catch (error) {
      if (attempt === 2 || nestedPostgresSqlState(error) !== "40P01") throw error;
    }
  }
}

export async function accountDeletionWork<T extends z.ZodType>(
  db: Database,
  action:
    | "due"
    | "dispatched"
    | "metrics"
    | "workflow_finished"
    | "resume_blocked"
    | "ticket"
    | "open"
    | "block"
    | "progress"
    | "finish"
    | "identity"
    | "apple_needed"
    | "retention"
    | "claim"
    | "finalize_retention"
    | "close_inventory"
    | "close_finish"
    | "authorize_workspace_quiesce"
    | "freeze_workspace"
    | "cleanup_inventory"
    | "cleanup_workspace"
    | "record_workspace_cleanup",
  input: Record<string, string | null>,
  schema: T,
): Promise<z.output<T>> {
  const [row] = await rawRows<{ value: unknown }>(
    db,
    sql`
    select opengeni_private.account_deletion_work_v1(${action}, ${JSON.stringify(input)}::jsonb) as value
  `,
  );
  return schema.parse(row?.value);
}

/** Reuse canonical cancellation for remaining service or previously owned
 * work, after the empty organization's exact deletion ticket is validated. */
export async function cancelClosedOrganizationWorkspaceSession(
  db: Database,
  scope: { requestId: string; ticket: string; organizationId: string; workspaceId: string },
) {
  return withWorkspaceSessionActivityRls(db, scope.workspaceId, async (tx) => {
    if (!(await accountDeletionWork(tx, "authorize_workspace_quiesce", scope, z.boolean())))
      return null;
    await lockWorkspaceInferenceControl(tx, scope.workspaceId, "update");
    const [active] = await rawRows<{ id: string }>(
      tx,
      sql`
      select id from sessions where workspace_id = ${scope.workspaceId}::uuid
        and status in ('queued','running','requires_action','recovering','waiting_capacity')
      order by (parent_session_id is not null), id limit 1
    `,
    );
    if (!active) return null;
    return mutateSessionControlInTransaction(tx, {
      accountId: scope.organizationId,
      workspaceId: scope.workspaceId,
      sessionId: active.id,
      actor: { type: "service", subjectId: "account-deletion" },
      operationKey: `account-deletion:${scope.requestId}:${active.id}`,
      action: "cancel",
    });
  });
}
