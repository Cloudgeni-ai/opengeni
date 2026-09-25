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
  decryptEnvironmentValue,
  pruneWorkspaceWebhookDeliveries,
  settleWorkspaceWebhookDelivery,
  type ClaimedWorkspaceWebhookDelivery,
  type Database,
} from "@opengeni/db";
import { pinnedFetch } from "@opengeni/network";
import type { Observability } from "@opengeni/observability";

const BATCH_SIZE = 32;
const CLAIM_SECONDS = 60;
const POLL_INTERVAL_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 10_000;
const PRUNE_EVERY_TICKS = 300;

export type WorkspaceWebhookDispatchDeps = {
  db: Database;
  settings: Settings;
  observability?: Pick<Observability, "info" | "warn" | "error">;
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
      { label: "Workspace webhook", requireHttpsOutsideLocalTest: true },
    );
    status = response.status;
    await response.body?.cancel().catch(() => undefined);
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (caught) {
    error = errorText(caught);
  }
  await settleWorkspaceWebhookDelivery(deps.db, {
    deliveryId: delivery.deliveryId,
    claimId,
    status,
    error,
  });
  return error === null ? "delivered" : "failed";
}

/** Claim and deliver one globally bounded batch. At-least-once: receivers dedupe on event id. */
export async function drainWorkspaceWebhookDeliveries(
  deps: WorkspaceWebhookDispatchDeps,
): Promise<WorkspaceWebhookBatchResult> {
  const key = environmentsEncryptionKeyBytes(deps.settings);
  if (!key) return { claimed: 0, delivered: 0, failed: 0 };
  const claimId = randomUUID();
  const claims = await claimWorkspaceWebhookDeliveries(deps.db, {
    claimId,
    limit: BATCH_SIZE,
    claimSeconds: CLAIM_SECONDS,
  });
  const outcomes = await Promise.all(
    claims.map(async (delivery) => {
      try {
        return await deliverOne(deps, key, claimId, delivery);
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
    claimed: claims.length,
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
  options: { intervalMs?: number } = {},
): () => Promise<void> {
  const intervalMs = Math.max(100, options.intervalMs ?? POLL_INTERVAL_MS);
  let stopped = false;
  let running: Promise<void> | undefined;
  let ticks = 0;

  const tick = (): void => {
    if (stopped || running) return;
    ticks += 1;
    running = (async () => {
      const result = await drainWorkspaceWebhookDeliveries(deps);
      if (result.claimed > 0) deps.observability?.info("Workspace webhook batch settled", result);
      if (ticks % PRUNE_EVERY_TICKS === 0) await pruneWorkspaceWebhookDeliveries(deps.db);
    })()
      .catch((error: unknown) => {
        deps.observability?.error("Workspace webhook dispatch failed", { error: errorText(error) });
      })
      .finally(() => {
        running = undefined;
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
