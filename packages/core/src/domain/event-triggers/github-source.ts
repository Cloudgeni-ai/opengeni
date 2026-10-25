import { createHmac } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type { EventTypeDescriptor } from "@opengeni/contracts";
import {
  areGitHubRepositoriesAllowedForWorkspace,
  createEventSource,
  getEventSource,
  listGitHubInstallationIdsForWorkspace,
  listGitHubEventRoutes,
  recordEventDelivery,
  type Database,
  type EventSourceRecord,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { readDelivery, retainedSourceHeaders, sha256Hex } from "./delivery-intake";
import {
  githubDeliveryInstallationId,
  githubDeliveryRepositoryId,
  githubEventTypeCatalog,
  parseGitHubPayload,
  verifyGitHubWebhook,
} from "./github-events";
import { eventMatchesTrigger } from "./matching";
import { WebhookBodyError } from "./webhook-adapters";
import { inboundWebhookBaseUrl } from "./webhook-url";

/**
 * The GitHub source: the deployment's GitHub App delivers its webhooks to one
 * receiver, and each delivery goes to the GitHub source of every workspace
 * bound to the installation and the repository it is about. A workspace has
 * at most one GitHub source, shared with the whole workspace, and it follows
 * the workspace's GitHub connection as installations are added and removed.
 */

/**
 * The secret GitHub event routes are keyed with, derived from the deployment's
 * encryption key, or null when the deployment has none. Every writer of a
 * workspace's GitHub bindings passes it so the routes follow the bindings.
 */
export function eventRouteSecret(settings: Settings): Uint8Array | null {
  const key = environmentsEncryptionKeyBytes(settings);
  return key
    ? new Uint8Array(createHmac("sha256", key).update("opengeni event ingress routes").digest())
    : null;
}

export const GITHUB_WEBHOOK_PATH = "/v1/webhooks/github";

/** One GitHub source per workspace. */
const GITHUB_EVENT_SOURCE_KEY = "app";

/** The GitHub App's webhook settings, through the host's App or this deployment's own. */
export type GitHubAppWebhookPort = {
  getWebhookSetup(): Promise<{ webhookUrl: string | null; events: string[] }>;
  setWebhookUrl(input: { url: string }): Promise<void>;
};

export function githubWebhookUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${GITHUB_WEBHOOK_PATH}`;
}

function sameUrl(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\/+$/u, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function githubUnavailable(error: unknown): HTTPException {
  const message = error instanceof Error ? error.message : String(error);
  return new HTTPException(503, {
    message: `Couldn't read the GitHub App's webhook settings (${message.slice(0, 200)}). Try again shortly.`,
  });
}

/**
 * Make sure the App sends its webhooks here. An App without a webhook URL is
 * pointed at this deployment; one that sends them elsewhere is left alone and
 * the person is told what to change, since another system may rely on it.
 */
async function ensureGitHubAppWebhook(
  app: GitHubAppWebhookPort,
  settings: Pick<Settings, "publicBaseUrl" | "webhookBaseUrl">,
): Promise<void> {
  let current: string | null;
  try {
    current = (await app.getWebhookSetup()).webhookUrl;
  } catch (error) {
    throw githubUnavailable(error);
  }
  const baseUrl = inboundWebhookBaseUrl(settings);
  const receiver = baseUrl ? githubWebhookUrl(baseUrl) : null;
  if (current !== null) {
    if (receiver === null || sameUrl(current, receiver)) return;
    throw new HTTPException(409, {
      message: `The GitHub App sends its webhooks to ${current}. Change its webhook URL to ${receiver} in the App's settings on GitHub, then add the source again.`,
    });
  }
  if (receiver === null) {
    throw new HTTPException(422, {
      message:
        "This deployment has no public address for GitHub to send events to. Set OPENGENI_PUBLIC_BASE_URL (or OPENGENI_WEBHOOK_BASE_URL) first.",
    });
  }
  try {
    await app.setWebhookUrl({ url: receiver });
  } catch (error) {
    throw githubUnavailable(error);
  }
}

/**
 * Add the workspace's GitHub source, or return the one it has. The workspace
 * must already be connected to GitHub.
 */
export async function createGitHubEventSource(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  createdBySubjectId: string;
  name?: string | undefined;
  githubApp?: GitHubAppWebhookPort | null;
}): Promise<EventSourceRecord> {
  if (!input.settings.githubWebhookSecret?.trim()) {
    throw new HTTPException(422, {
      message:
        "This deployment's GitHub App has no webhook secret (OPENGENI_GITHUB_WEBHOOK_SECRET), so it can't receive GitHub events",
    });
  }
  const routeSecret = eventRouteSecret(input.settings);
  if (!routeSecret) {
    throw new HTTPException(503, {
      message: "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required for GitHub event sources",
    });
  }
  const installations = await listGitHubInstallationIdsForWorkspace(input.db, input.workspaceId);
  if (installations.length === 0) {
    throw new HTTPException(422, { message: "Connect GitHub to this workspace first" });
  }
  if (input.githubApp) await ensureGitHubAppWebhook(input.githubApp, input.settings);
  const { source } = await createEventSource(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    createdBySubjectId: input.createdBySubjectId,
    kind: "github",
    name: input.name ?? "GitHub",
    ownerSubjectId: null,
    visibility: "workspace",
    externalKey: GITHUB_EVENT_SOURCE_KEY,
    routeSecret,
  });
  return source;
}

/**
 * The event types a GitHub trigger can name. Types the App is not subscribed
 * to are marked unavailable; if GitHub can't be asked, every type is offered.
 */
export async function githubSourceEventTypes(
  recent: ReadonlyArray<{ type: string; count: number }>,
  app: GitHubAppWebhookPort | null,
): Promise<EventTypeDescriptor[]> {
  let subscribed: Set<string> | null = null;
  if (app) {
    try {
      subscribed = new Set((await app.getWebhookSetup()).events);
    } catch {
      subscribed = null;
    }
  }
  return githubEventTypeCatalog(recent, subscribed);
}

export type GitHubWebhookIntakeResult =
  | { outcome: "not_found" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "unreadable"; reason: string }
  | { outcome: "received"; deliveries: number };

/**
 * One delivery from the deployment's GitHub App. Nothing is parsed before the
 * signature is checked over the exact raw body. A route only names candidate
 * workspaces: each must still be bound to the installation and allowed the
 * delivery's repository, so a workspace sees events of exactly the
 * repositories its agents can use.
 */
export async function receiveGitHubWebhook(input: {
  db: Database;
  settings: Settings;
  headers: Headers;
  body: Uint8Array;
  receivedAt?: Date;
}): Promise<GitHubWebhookIntakeResult> {
  const secret = input.settings.githubWebhookSecret?.trim();
  const routeSecret = eventRouteSecret(input.settings);
  if (input.settings.eventTriggersEnabled !== true || !secret || !routeSecret) {
    return { outcome: "not_found" };
  }
  if (!verifyGitHubWebhook({ secret, headers: input.headers, body: input.body })) {
    return { outcome: "rejected", reason: "The signature does not match" };
  }
  let payload: Record<string, unknown>;
  try {
    payload = parseGitHubPayload(input.body);
  } catch (error) {
    if (error instanceof WebhookBodyError) return { outcome: "unreadable", reason: error.message };
    throw error;
  }
  const installationId = githubDeliveryInstallationId(payload);
  const repositoryId = githubDeliveryRepositoryId(payload);
  if (installationId === null || repositoryId === null)
    return { outcome: "received", deliveries: 0 };
  const routes = await listGitHubEventRoutes(input.db, routeSecret, installationId);
  const receivedAt = input.receivedAt ?? new Date();
  const bodySha256 = sha256Hex(input.body);
  const githubDeliveryId = input.headers.get("x-github-delivery")?.trim();
  let deliveries = 0;
  for (const route of routes) {
    const allowed = await areGitHubRepositoriesAllowedForWorkspace(
      input.db,
      route.workspaceId,
      installationId,
      [repositoryId],
    );
    if (!allowed) continue;
    const source = await getEventSource(input.db, route.workspaceId, route.sourceId);
    if (!source || source.kind !== "github") continue;
    const outcome = readDelivery({
      source,
      settings: input.settings,
      headers: input.headers,
      body: input.body,
      receivedAt,
      refire: false,
    });
    await recordEventDelivery(input.db, {
      accountId: source.accountId,
      workspaceId: source.workspaceId,
      sourceId: source.id,
      ...outcome,
      dedupeKey: githubDeliveryId ? `github:${githubDeliveryId}` : `sha256:${bodySha256}`,
      body: input.body,
      bodyBytes: input.body.byteLength,
      bodySha256,
      headers: retainedSourceHeaders(source, input.headers),
      match: eventMatchesTrigger,
    });
    deliveries += 1;
  }
  return { outcome: "received", deliveries };
}
