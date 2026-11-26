import {
  AccountDeletionWork,
  accountDeletionAvailable,
  accountDeletionWork,
  cancelClosedOrganizationWorkspaceSession,
  completeOrganizationRetentionDeletion,
  listOrganizationRetentionDeletionObjects,
  recordOrganizationRetentionObjectDeleted,
  safeDatabaseErrorFacts,
} from "@opengeni/db";
import { OrganizationRetentionDeletionClaim } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { revokeManagedAppleTokens } from "./auth/apple-sign-in";
import {
  deleteClosedOrganizationStripeCustomers,
  StripeCustomerDeletionBlocked,
} from "./billing-stripe-customer";
import { deleteWorkspaceForRequest } from "./workspace-deletion";
import { dropSiteSqlDatabases } from "./site-sql/service";

const retentionInventory = z.array(
  z.object({
    organizationId: z.uuid(),
    membershipId: z.uuid(),
    dueAt: z.iso.datetime({ offset: true }),
  }),
);
const closureInventory = z.object({
  workspaceIds: z.array(z.uuid()),
  stripeCustomers: z.array(
    z.object({ provider: z.enum(["stripe", "stripe:live", "stripe:test"]), id: z.string() }),
  ),
});
const cleanupInventory = z.array(z.object({ organizationId: z.uuid(), workspaceId: z.uuid() }));
const workspaceCleanup = z.array(
  z.object({
    kind: z.enum(["object", "site_sql"]),
    key: z.string(),
    bucket: z.string().nullable(),
  }),
);
const deletionGauges = z.object({
  blocked: z.number(),
  terminal: z.number(),
  overdue: z.number(),
  stalled: z.number(),
});

class DeletionBlocked extends Error {
  constructor(
    readonly reason: string,
    readonly terminal = false,
  ) {
    super(reason);
  }
}

export async function dispatchAccountDeletion(deps: ApiRouteDeps, id: string) {
  if (!deps.workflowClient.startAccountDeletion) return;
  await deps.workflowClient.startAccountDeletion(id);
  await accountDeletionWork(deps.db, "dispatched", { requestId: id }, z.null());
}

/** The accepted DB request is its own outbox. Neither a crashed API nor an
 * ambiguous Temporal start can lose it. All replicas use the same workflow ID. */
export function startAccountDeletionDispatch(deps: ApiRouteDeps) {
  let pass: Promise<void> | null = null;
  let stopped = false;
  const pump = () => {
    if (stopped || pass || !deps.workflowClient.startAccountDeletion) return;
    pass = (async () => {
      if (!(await accountDeletionAvailable(deps.db))) return;
      const counts = await accountDeletionWork(deps.db, "metrics", {}, deletionGauges);
      for (const [state, value] of Object.entries(counts)) {
        deps.observability?.setGauge({
          name: "opengeni_account_deletion_requests",
          help: "Durable account deletions requiring attention.",
          labels: { state },
          value,
        });
      }
      for (const id of await accountDeletionWork(deps.db, "due", {}, z.array(z.uuid()))) {
        if (stopped) break;
        await dispatchAccountDeletion(deps, id).catch(() => {
          deps.observability?.warn("Account deletion dispatch is pending", { requestId: id });
        });
      }
    })()
      .catch(() => {
        deps.observability?.warn("Account deletion dispatch inventory will retry");
      })
      .finally(() => {
        pass = null;
      });
  };
  const timer = setInterval(pump, 15_000);
  timer.unref?.();
  pump();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pass;
  };
}

/** One bounded phase per activity, with PII kept in the API/DB and never put
 * in Temporal histories or error messages. */
export async function runAccountDeletionStep(
  deps: ApiRouteDeps,
  handle: { requestId: string; ticket: string },
) {
  const row = await accountDeletionWork(deps.db, "open", handle, AccountDeletionWork.nullable());
  if (!row) return null;
  if (row.terminalFailure) return { done: true, waitMs: 0 };
  let step = "retention";
  const progress = (key: string) =>
    accountDeletionWork(deps.db, "progress", { ...handle, step: key }, z.null());
  try {
    const appleRelay = row.email?.toLowerCase().endsWith("@privaterelay.appleid.com") === true;
    // Erase identity before any provider can block, except when Apple must
    // keep a relay address deliverable for the data-erasure confirmation.
    if ((!appleRelay || row.progress.email) && !row.progress.apple) {
      step = "apple";
      if (await accountDeletionWork(deps.db, "apple_needed", handle, z.boolean())) {
        if (!deps.managedAuth) throw new Error("Managed sign-in is unavailable");
        const result = await revokeManagedAppleTokens(
          deps.managedAuth,
          deps.settings,
          row.authUserId,
        );
        if (result !== "revoked") throw new Error("Linked Apple credential was not resolved");
      }
      await progress(step);
      return { done: false, waitMs: 0 };
    }
    if ((!appleRelay || row.progress.email) && !row.progress.identity) {
      step = "identity";
      await accountDeletionWork(deps.db, "identity", handle, z.null());
      return { done: false, waitMs: 0 };
    }
    // Read the inventory live: an organization's retention deadline starts
    // at offboarding and is outside Opengeni's identity-erasure timeline.
    const retention = await accountDeletionWork(deps.db, "retention", handle, retentionInventory);
    const isClosing = (id: string) =>
      row.plan.some((org) => org.organizationId === id && org.kind === "close");
    const due = retention.find((candidate) => Date.parse(candidate.dueAt) <= Date.now());
    if (due) {
      step = `retention:${due.membershipId}`;
      const storage = deps.objectStorage;
      const objectBucket = storage?.bucket ?? "unconfigured";
      const scope = { organizationId: due.organizationId, membershipId: due.membershipId };
      const claim = await accountDeletionWork(
        deps.db,
        "claim",
        { ...handle, ...scope },
        OrganizationRetentionDeletionClaim.nullable(),
      );
      if (!claim) throw new DeletionBlocked("retention_claim_unavailable");
      const target = { ...scope, operationId: claim.operationId, objectBucket };
      await accountDeletionWork(
        deps.db,
        "finalize_retention",
        { ...handle, ...scope, operationId: claim.operationId, bucket: objectBucket },
        z.null(),
      );
      const objects = await listOrganizationRetentionDeletionObjects(deps.db, {
        ...target,
        limit: 10,
      });
      if (!objects.length) {
        await completeOrganizationRetentionDeletion(deps.db, target);
      } else {
        for (const object of objects) {
          if (object.objectKind === "site_sql") {
            const result = await dropSiteSqlDatabases(deps, [object.objectKey]);
            if (result.status === "not_configured")
              throw new DeletionBlocked("site_sql_gateway_not_configured", true);
            if (!result.dropped.includes(object.objectKey))
              throw new Error("Site SQL cleanup is unavailable");
          } else {
            if (!storage || object.objectBucket !== storage.bucket)
              throw new Error("Retention bucket mismatch or storage not configured");
            await storage.deleteObject(object.objectKey);
          }
          if (
            !(await recordOrganizationRetentionObjectDeleted(deps.db, {
              ...target,
              ...object,
              siteSqlHandled: object.objectKind === "site_sql",
            }))
          ) {
            throw new Error("Retention object receipt rejected");
          }
        }
      }
      return { done: false, waitMs: 0 };
    }
    const retentionWait =
      Math.min(...retention.map((candidate) => Date.parse(candidate.dueAt))) - Date.now();
    const retainedCleanup = Number.isFinite(retentionWait)
      ? { done: false, waitMs: Math.max(1, retentionWait) }
      : { done: true };
    const [pendingCleanup] = await accountDeletionWork(
      deps.db,
      "cleanup_inventory",
      handle,
      cleanupInventory,
    );
    if (pendingCleanup) {
      step = `workspace_cleanup:${pendingCleanup.workspaceId}`;
      const target = { ...handle, ...pendingCleanup };
      const obligations = await accountDeletionWork(
        deps.db,
        "cleanup_workspace",
        target,
        workspaceCleanup,
      );
      if (!obligations.length) throw new Error("Workspace cleanup inventory is not ready");
      for (const obligation of obligations) {
        if (obligation.kind === "site_sql") {
          const result = await dropSiteSqlDatabases(deps, [obligation.key], target);
          if (result.status === "not_configured")
            throw new DeletionBlocked("site_sql_gateway_not_configured", true);
          if (!result.dropped.includes(obligation.key))
            throw new Error("Site SQL cleanup is unavailable");
        } else {
          if (!deps.objectStorage || deps.objectStorage.bucket !== obligation.bucket)
            throw new Error("Workspace object bucket unavailable");
          await deps.objectStorage.deleteObject(obligation.key);
        }
        await accountDeletionWork(
          deps.db,
          "record_workspace_cleanup",
          { ...target, ...obligation },
          z.null(),
        );
      }
      return { done: false, waitMs: 0 };
    }
    if (row.status === "completed") {
      if (retainedCleanup.done)
        await accountDeletionWork(deps.db, "workflow_finished", handle, z.null());
      return retainedCleanup;
    }
    const org = row.plan.find(
      (candidate) =>
        candidate.kind === "close" && !row.progress[`organization:${candidate.organizationId}`],
    );
    if (org) {
      step = `organization:${org.organizationId}`;
      if (
        retention.some(
          (candidate) =>
            candidate.organizationId === org.organizationId && isClosing(candidate.organizationId),
        )
      ) {
        throw new Error("Closed organization retention is not due");
      }
      const scope = { ...handle, organizationId: org.organizationId };
      const inventory = await accountDeletionWork(
        deps.db,
        "close_inventory",
        scope,
        closureInventory,
      );
      const workspaceId = inventory.workspaceIds[0];
      if (workspaceId) {
        const cancelled = await cancelClosedOrganizationWorkspaceSession(deps.db, {
          ...scope,
          workspaceId,
        });
        if (cancelled?.outcome === "changed") {
          if (cancelled.wakeCount > 0) {
            await deps.workflowClient.requestSessionWorkflowWakeDispatch?.().catch(() => undefined);
          }
          return { done: false, waitMs: 0 };
        }
        await deleteWorkspaceForRequest(deps, {
          accountId: org.organizationId,
          workspaceId,
          accountDeletionRequestId: row.id,
          beforeClosureCascade: (tx) =>
            accountDeletionWork(
              tx,
              "freeze_workspace",
              {
                ...scope,
                workspaceId,
                bucket: deps.objectStorage?.bucket ?? null,
              },
              z.null(),
            ),
        }).catch((error: unknown) => {
          if (!(error instanceof HTTPException && error.status === 404)) throw error;
        });
        return { done: false, waitMs: 0 };
      }
      await deleteClosedOrganizationStripeCustomers(
        deps.settings,
        org.organizationId,
        inventory.stripeCustomers,
        row.progress,
        progress,
      );
      await accountDeletionWork(deps.db, "close_finish", scope, z.null());
      return { done: false, waitMs: 0 };
    }
    if (!row.progress.email) {
      step = "email";
      if (!row.email) throw new Error("Confirmation address is missing");
      // Some passkey-only accounts intentionally have no routable address.
      if (!row.email.toLowerCase().endsWith(".invalid")) {
        const text = appleRelay
          ? "We’ve deleted the data covered by your Opengeni account deletion request. We’re now removing your sign-in information and disconnecting Sign in with Apple."
          : "Your Opengeni account has been deleted.";
        const result = await deps.managedEmailTransport.send({
          kind: "account_deletion_completed",
          from: deps.managedEmailTransport.sender,
          to: row.email,
          subject: appleRelay
            ? "Your Opengeni account deletion"
            : "Your Opengeni account was deleted",
          text,
          html: `<p>${text}</p>`,
          idempotencyKey: `account-deletion-confirmation:${row.id}`,
        });
        if (result.status !== "sent") throw new Error("Confirmation email was not sent");
      }
      await progress(step);
      return { done: false, waitMs: 0 };
    }
    step = "completion";
    const done = await accountDeletionWork(deps.db, "finish", handle, z.boolean());
    if (!done) throw new Error("Deletion completion was refused");
    if (retainedCleanup.done)
      await accountDeletionWork(deps.db, "workflow_finished", handle, z.null());
    return retainedCleanup;
  } catch (error) {
    const stall =
      row.blockedStep === step &&
      row.stalledSince !== null &&
      Date.now() - Date.parse(row.stalledSince) > 24 * 60 * 60 * 1000;
    const blocked =
      error instanceof DeletionBlocked || error instanceof StripeCustomerDeletionBlocked;
    const reason = blocked ? error.reason : "step_failed";
    const terminal = (blocked && error.terminal) || stall;
    await accountDeletionWork(
      deps.db,
      "block",
      { ...handle, step, reason, terminal: String(terminal) },
      z.null(),
    );
    const { plpgsql, ...facts } = safeDatabaseErrorFacts(error);
    deps.observability?.warn(
      terminal ? "Account deletion needs operator attention" : "Account deletion step will retry",
      {
        requestId: row.id,
        step,
        reason,
        terminal,
        ...facts,
        ...(plpgsql?.length ? { location: plpgsql.join(", ") } : {}),
      },
    );
    return {
      done: terminal,
      waitMs: terminal ? 0 : step.startsWith("retention:") ? 60_000 : 5 * 60_000,
    };
  }
}
