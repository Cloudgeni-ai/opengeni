import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import type { EventDeliveryStatus } from "@opengeni/contracts";
import type { EventSourceRecord, StoredEventInput } from "@opengeni/db";
import { GITHUB_RETAINED_HEADERS, githubOwnLogins, readGitHubDelivery } from "./github-events";
import { boundEvent } from "./normalize";
import { readSlackDelivery } from "./slack-events";
import {
  retainedWebhookHeaders,
  webhookAdapter,
  WebhookBodyError,
  type WebhookAdapterReading,
} from "./webhook-adapters";

/**
 * Reading a verified delivery into events, shared by every source that
 * receives HTTP deliveries (webhook endpoints and apps) and by replay.
 */

export type DeliveryReadingSettings = Pick<Settings, "githubAppSlug" | "prReviewGithubAppSlug">;

export function sha256Hex(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Logins of this deployment's own GitHub Apps, whose events are Opengeni's. */
export function deploymentGitHubOwnLogins(settings: DeliveryReadingSettings): Set<string> {
  return githubOwnLogins([settings.githubAppSlug, settings.prReviewGithubAppSlug]);
}

function readSourceDelivery(
  source: EventSourceRecord,
  settings: DeliveryReadingSettings,
  input: { headers: Headers; body: Uint8Array; receivedAt: Date },
): WebhookAdapterReading {
  switch (source.kind) {
    case "github":
      return readGitHubDelivery({ ...input, ownLogins: deploymentGitHubOwnLogins(settings) });
    case "slack":
      return readSlackDelivery(input);
    case "webhook":
      return webhookAdapter(source.adapter ?? "standard").read(input);
    default:
      throw new Error(`${source.kind} deliveries are not read from HTTP requests`);
  }
}

/** The headers kept with a delivery's body, so it can be read again on replay. */
export function retainedSourceHeaders(
  source: EventSourceRecord,
  headers: Headers,
): Record<string, string> {
  switch (source.kind) {
    case "webhook":
      return retainedWebhookHeaders(source.adapter ?? "standard", headers);
    case "github": {
      const kept: Record<string, string> = {};
      for (const name of GITHUB_RETAINED_HEADERS) {
        const value = headers.get(name);
        if (value !== null) kept[name] = value.slice(0, 512);
      }
      return kept;
    }
    default:
      return {};
  }
}

export type DeliveryOutcome = {
  status: EventDeliveryStatus;
  reason: string | null;
  events: StoredEventInput[];
};

/**
 * A verified delivery's outcome: its bounded events, or why it was ignored or
 * could not be read. A replay re-fires its events on purpose, so they skip
 * event deduplication (`refire`).
 */
export function readDelivery(input: {
  source: EventSourceRecord;
  settings: DeliveryReadingSettings;
  headers: Headers;
  body: Uint8Array;
  receivedAt: Date;
  refire: boolean;
}): DeliveryOutcome {
  const { source, receivedAt } = input;
  if (source.status !== "active") {
    return {
      status: "ignored",
      reason:
        source.status === "disabled"
          ? "The source is turned off"
          : (source.statusReason ?? "The source is blocked"),
      events: [],
    };
  }
  let reading: WebhookAdapterReading;
  try {
    reading = readSourceDelivery(source, input.settings, {
      headers: input.headers,
      body: input.body,
      receivedAt,
    });
  } catch (error) {
    if (error instanceof WebhookBodyError) {
      return { status: "failed", reason: error.message, events: [] };
    }
    throw error;
  }
  if (reading.kind === "ignored") return { status: "ignored", reason: reading.reason, events: [] };
  return {
    status: "accepted",
    reason: null,
    events: reading.events.map((event) => {
      const bounded = boundEvent(event, receivedAt);
      return input.refire ? { ...bounded, externalId: null } : bounded;
    }),
  };
}
