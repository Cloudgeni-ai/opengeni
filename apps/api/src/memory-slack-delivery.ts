import {
  claimMemorySlackPublication,
  completeMemorySlackPublication,
  currentMemorySlackConfigurationMatches,
  deferMemorySlackPublication,
  failMemorySlackPublication,
  type ClaimedMemorySlackPublication,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createOpenGeniSlackBotInteractionClient,
  SlackBotProviderError,
} from "./integrations/slack-bot";

const DELIVERY_LEASE_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 8;
const MAX_DELIVERY_RETRY_MS = 5 * 60_000;
const MAX_SLACK_MESSAGE_CHARS = 3_500;

export async function drainMemorySlackPublicationsOnce(deps: ApiRouteDeps): Promise<boolean> {
  const claimHolderId = crypto.randomUUID();
  const publication = await claimMemorySlackPublication(deps.db, claimHolderId, DELIVERY_LEASE_MS);
  if (!publication) return false;

  try {
    if (!(await currentMemorySlackConfigurationMatches(deps.db, publication))) {
      await failMemorySlackPublication(deps.db, {
        publication,
        claimHolderId,
        errorCode: "configuration_changed",
        cancelled: true,
      });
      return true;
    }
    const client = await createOpenGeniSlackBotInteractionClient(deps, {
      accountId: publication.accountId,
      workspaceId: publication.workspaceId,
      connectionId: publication.connectionId,
      subjectId: publication.initiatorSubjectId,
      sessionId: publication.sessionId,
    });
    const result = await client.postMessage({
      operationId: publication.operationId,
      channelId: publication.slackChannelId,
      text: formatMemorySlackPublicationMessage(deps, publication),
    });
    const completed = await completeMemorySlackPublication(deps.db, {
      publication,
      claimHolderId,
      slackChannelId: result.channelId,
      slackMessageTimestamp: result.timestamp,
    });
    if (!completed) throw new Error("Memory Slack publication lost its durable claim");
  } catch (error) {
    const errorCode = deliveryErrorCode(error);
    if (publication.attemptCount >= MAX_DELIVERY_ATTEMPTS || permanentDeliveryError(error)) {
      await failMemorySlackPublication(deps.db, {
        publication,
        claimHolderId,
        errorCode,
      }).catch(() => undefined);
    } else {
      await deferMemorySlackPublication(deps.db, {
        publication,
        claimHolderId,
        errorCode,
        retryAt: new Date(Date.now() + deliveryRetryMs(error, publication.attemptCount)),
      }).catch(() => undefined);
    }
  }
  return true;
}

export function startMemorySlackPublicationPump(
  deps: ApiRouteDeps,
  options: { intervalMs?: number; maxPerTick?: number } = {},
): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | undefined;
  const intervalMs = Math.max(250, options.intervalMs ?? 1_000);
  const maxPerTick = Math.max(1, Math.min(50, options.maxPerTick ?? 10));
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      for (let index = 0; index < maxPerTick; index += 1) {
        if (!(await drainMemorySlackPublicationsOnce(deps))) break;
      }
    })()
      .catch((error) => {
        deps.observability?.error("Memory Slack publication claim failed", {
          errorClass: error instanceof Error ? error.name : "MemorySlackPublicationPumpError",
          errorCode: deliveryErrorCode(error),
          origin: "api",
        });
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

export function formatMemorySlackPublicationMessage(
  deps: Pick<ApiRouteDeps, "settings">,
  publication: ClaimedMemorySlackPublication,
): string {
  const projection = publication.projection;
  const summary = boundedProjectionString(projection["summary"], 512) || "Important change";
  const owner = boundedProjectionString(projection["ownerLabel"], 96);
  const occurredAt = boundedProjectionString(projection["occurredAt"], 64);
  const changeKind = boundedProjectionString(projection["changeKind"], 32);
  const destination = boundedProjectionString(projection["destination"], 64);
  const outcome = boundedProjectionString(projection["outcome"], 64);
  const heading =
    publication.sourceType === "workspace_memory"
      ? `Workspace Memory ${changeKind || "change"}`
      : `Governed learning ${outcome || "change"}`;
  const details = [
    `Importance: ${publication.importance}`,
    ...(destination ? [`Surface: ${destination}`] : []),
    ...(owner ? [`Owner: ${owner}`] : []),
    ...(occurredAt ? [`Recorded: ${occurredAt}`] : []),
  ];
  const path =
    publication.sourceType === "workspace_memory"
      ? `/workspaces/${publication.workspaceId}/memory?memoryId=${encodeURIComponent(publication.sourceId)}`
      : `/workspaces/${publication.workspaceId}/workspace-state`;
  const base = deps.settings.webBaseUrl ?? deps.settings.publicBaseUrl;
  const link = base ? new URL(path, base).toString() : null;
  const text = `*${heading}*\n${summary}\n\n${details.join(" · ")}${link ? `\n${link}` : ""}`;
  return text.length <= MAX_SLACK_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_SLACK_MESSAGE_CHARS - 20)}\n… message truncated`;
}

const PERMANENT_DELIVERY_CODES = new Set([
  "account_inactive",
  "channel_not_found",
  "invalid_auth",
  "is_archived",
  "not_authed",
  "not_in_channel",
  "token_expired",
  "token_revoked",
]);

function permanentDeliveryError(error: unknown) {
  if (!(error instanceof SlackBotProviderError)) return false;
  if (PERMANENT_DELIVERY_CODES.has(error.code)) return true;
  const status = /^http_(\d{3})$/.exec(error.code)?.[1];
  return status
    ? Number(status) >= 400 && Number(status) < 500 && status !== "408" && status !== "429"
    : false;
}

function deliveryRetryMs(error: unknown, attemptCount: number) {
  if (error instanceof SlackBotProviderError && error.retryAfterMs) {
    return Math.min(Math.max(error.retryAfterMs, 1_000), MAX_DELIVERY_RETRY_MS);
  }
  return Math.min(1_000 * 2 ** Math.max(0, attemptCount - 1), MAX_DELIVERY_RETRY_MS);
}

function deliveryErrorCode(error: unknown) {
  if (error instanceof SlackBotProviderError) return error.code.slice(0, 128);
  const raw = error instanceof Error ? error.name : "memory_slack_delivery_error";
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 128) || "error"
  );
}

function boundedProjectionString(value: unknown, maxChars: number) {
  return typeof value === "string" ? escapeSlackText(value.slice(0, maxChars)) : "";
}

function escapeSlackText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
