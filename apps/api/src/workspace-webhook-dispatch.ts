import { randomUUID } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  OPENGENI_DELIVERY_ID_HEADER,
  OPENGENI_EVENT_ID_HEADER,
  OPENGENI_SIGNATURE_HEADER,
  signOpenGeniPayload,
} from "@opengeni/contracts";
import {
  claimWorkspaceWebhookDeliveries,
  claimOrganizationWebhookDeliveries,
  decryptEnvironmentValue,
  maintainSessionUsageLimits,
  maintainWorkspaceAllowances,
  pruneOrganizationWebhookDeliveries,
  pruneWorkspaceWebhookDeliveries,
  settleOrganizationWebhookDelivery,
  settleWorkspaceWebhookDelivery,
  type ClaimedWorkspaceWebhookDelivery,
  type Database,
} from "@opengeni/db";
import { pinnedFetch } from "@opengeni/network";
import type { Observability } from "@opengeni/observability";
import { recordSessionUsageLimitEvent } from "@opengeni/core";

export const WORKSPACE_WEBHOOK_DISPATCH_BATCH_SIZE = 32;
const CLAIM_SECONDS = 60;
const POLL_INTERVAL_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 10_000;
const PRUNE_EVERY_TICKS = 300;

export type WorkspaceWebhookDispatchDeps = {
  db: Database;
  settings: Settings;
  observability?: Pick<Observability, "info" | "warn" | "error"> &
    Partial<Pick<Observability, "incrementCounter">>;
  fetch?: typeof pinnedFetch;
};

export type WorkspaceWebhookBatchResult = { claimed: number; delivered: number; failed: number };

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
    return `${error.name}: ${error.message}`.slice(0, 500);
  }
  return String(error).slice(0, 500);
}

async function deliverOne(
  deps: WorkspaceWebhookDispatchDeps,
  key: Uint8Array,
  claimId: string,
  delivery: ClaimedWorkspaceWebhookDelivery,
  organization = false,
): Promise<"delivered" | "failed"> {
  let status: number | null = null;
  let error: string | null = null;
  try {
    const body = JSON.stringify(delivery.payload);
    const secret = decryptEnvironmentValue(key, delivery.secretEncrypted);
    const response = await (deps.fetch ?? pinnedFetch)(
      delivery.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "OpenGeni-Webhooks/1",
          [OPENGENI_SIGNATURE_HEADER]: await signOpenGeniPayload(secret, body),
          [OPENGENI_EVENT_ID_HEADER]: delivery.eventId,
          [OPENGENI_DELIVERY_ID_HEADER]: delivery.deliveryId,
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      },
      deps.settings,
      {
        label: organization ? "Organization webhook" : "Workspace webhook",
        requireHttpsOutsideLocalTest: true,
      },
    );
    status = response.status;
    await response.body?.cancel().catch(() => undefined);
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (caught) {
    error = errorText(caught);
  }
  await (organization ? settleOrganizationWebhookDelivery : settleWorkspaceWebhookDelivery)(
    deps.db,
    {
      deliveryId: delivery.deliveryId,
      claimId,
      status,
      error,
    },
  );
  return error === null ? "delivered" : "failed";
}

/**
 * One bounded, resumable page of the per-task usage limit legacy import.
 * Roots created before the feature stay `preparing` (never shown or
 * admitted as $0 for a write) until this converges them. A failure is retried
 * on a later tick (per-root exponential backoff with its SQLSTATE kept) and
 * never blocks webhook delivery. The same pass discloses lost single-call
 * custody markers as unpriced so a crashed process cannot block a task forever.
 */
async function importLegacySessionUsage(deps: WorkspaceWebhookDispatchDeps): Promise<void> {
  const sink = deps.observability?.incrementCounter ? deps.observability : null;
  const metrics = sink as Pick<Observability, "incrementCounter"> | null;
  try {
    const result = await maintainSessionUsageLimits(deps.db);
    recordSessionUsageLimitEvent(metrics, "import", "imported", result.processed);
    recordSessionUsageLimitEvent(metrics, "import", "import_failed", result.failed);
    recordSessionUsageLimitEvent(metrics, "single_call", "lost_resolved", result.resolvedLost);
    if (result.failed > 0) {
      deps.observability?.warn("Session usage limit import pages failed", {
        failed: result.failed,
        sqlstates: JSON.stringify(result.errors),
      });
    }
  } catch (error) {
    recordSessionUsageLimitEvent(metrics, "import", "import_failed");
    deps.observability?.warn("Session usage limit import failed", { error: errorText(error) });
  }
}

/** Claim and deliver one globally bounded batch. At-least-once: receivers dedupe on event id. */
export async function drainWorkspaceWebhookDeliveries(
  deps: WorkspaceWebhookDispatchDeps,
): Promise<WorkspaceWebhookBatchResult> {
  // Usage-limit maintenance contains its own failures, so it runs first: a
  // failing allowance pass cannot keep lost custody markers (and the tasks
  // they park) unresolved.
  await importLegacySessionUsage(deps);
  // Allowance rollover/expiry does not depend on webhook secrets, usage
  // readers, inference or having any pending delivery.
  await maintainWorkspaceAllowances(deps.db);
  const key = environmentsEncryptionKeyBytes(deps.settings);
  if (!key) return { claimed: 0, delivered: 0, failed: 0 };
  const claimId = randomUUID();
  const claims = await claimWorkspaceWebhookDeliveries(deps.db, {
    claimId,
    limit: WORKSPACE_WEBHOOK_DISPATCH_BATCH_SIZE,
    claimSeconds: CLAIM_SECONDS,
  });
  // Each lane is bounded; the shared pump does not starve organization queues
  // behind a sustained workspace backlog.
  const organizationClaims = await claimOrganizationWebhookDeliveries(deps.db, {
    claimId,
    limit: WORKSPACE_WEBHOOK_DISPATCH_BATCH_SIZE,
    claimSeconds: CLAIM_SECONDS,
  });
  const outcomes = await Promise.all(
    [
      ...claims.map((delivery) => ({ delivery, organization: false })),
      ...organizationClaims.map((delivery) => ({ delivery, organization: true })),
    ].map(async ({ delivery, organization }) => {
      try {
        return await deliverOne(deps, key, claimId, delivery, organization);
      } catch (error) {
        deps.observability?.warn("Workspace webhook settlement failed", {
          deliveryId: delivery.deliveryId,
          error: errorText(error),
        });
        return "failed" as const;
      }
    }),
  );
  return {
    claimed: claims.length + organizationClaims.length,
    delivered: outcomes.filter((outcome) => outcome === "delivered").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
  };
}

/**
 * One non-overlapping loop per API replica. PostgreSQL claims coordinate
 * replicas; a crash only delays a delivery until its claim expires.
 */
export function startWorkspaceWebhookDispatchPump(
  deps: WorkspaceWebhookDispatchDeps,
  options: {
    intervalMs?: number;
    drain?: (deps: WorkspaceWebhookDispatchDeps) => Promise<WorkspaceWebhookBatchResult>;
  } = {},
): () => Promise<void> {
  const intervalMs = Math.max(100, options.intervalMs ?? POLL_INTERVAL_MS);
  const drain = options.drain ?? drainWorkspaceWebhookDeliveries;
  let stopped = false;
  let running: Promise<void> | undefined;
  let ticks = 0;

  const tick = (): void => {
    if (stopped || running) return;
    ticks += 1;
    // A full batch means a backlog: drain it now instead of one batch per interval.
    let backlog = false;
    running = (async () => {
      const result = await drain(deps);
      backlog = result.claimed >= WORKSPACE_WEBHOOK_DISPATCH_BATCH_SIZE;
      if (result.claimed > 0) deps.observability?.info("Workspace webhook batch settled", result);
      if (ticks % PRUNE_EVERY_TICKS === 0) {
        await pruneWorkspaceWebhookDeliveries(deps.db);
        await pruneOrganizationWebhookDeliveries(deps.db);
      }
    })()
      .catch((error: unknown) => {
        deps.observability?.error("Workspace webhook dispatch failed", { error: errorText(error) });
      })
      .finally(() => {
        running = undefined;
        if (backlog && !stopped) queueMicrotask(tick);
      });
  };

  const timer = setInterval(tick, intervalMs);
  queueMicrotask(tick);

  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
