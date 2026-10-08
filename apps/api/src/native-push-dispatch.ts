import { createSign, randomUUID } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import type { Settings } from "@opengeni/config";
import {
  claimNativePushDeliveries,
  pruneNativePushDeliveries,
  settleNativePushDelivery,
  type ClaimedNativePushDelivery,
  type Database,
  type NativePushOutcome,
} from "@opengeni/db";
import type { Observability } from "@opengeni/observability";

// Sends queued native app pushes (0638) through APNs (token auth over HTTP/2)
// and FCM HTTP v1. At-least-once: a delivery is settled only after the
// provider answered; an unknown token removes the registration.

const POLL_INTERVAL_MS = 1_000;
const CLAIM_SECONDS = 60;
const MAX_ATTEMPTS = 6;
const PRUNE_EVERY_TICKS = 600;

export type NativePushSendResult = { outcome: NativePushOutcome; error?: string };

export type NativePushSender = (
  delivery: ClaimedNativePushDelivery,
) => Promise<NativePushSendResult>;

export type NativePushDispatchDeps = {
  db: Database;
  settings: Settings;
  observability?: Pick<Observability, "info" | "warn" | "error">;
  senders?: Partial<Record<"ios" | "android", NativePushSender>>;
};

/**
 * A notification message as plain text for the lock screen: links keep their
 * text, emphasis and code marks go, and "- " bullets become "•".
 */
export function plainNotificationText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/gu, "$1")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/^[ \t]*[-*][ \t]+/gmu, "• ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** The visible text of a push: title, optional subtitle, and the message with its facts. */
export function nativePushAlert(payload: ClaimedNativePushDelivery["payload"]): {
  title: string;
  subtitle?: string;
  body?: string;
} {
  const fallback =
    payload.rule === "needs_input"
      ? "The agent needs you"
      : payload.rule === "failed"
        ? "A turn failed"
        : payload.rule === "reply_ready"
          ? "Reply ready"
          : "Opengeni";
  const facts = (payload.facts ?? [])
    .slice(0, 4)
    .map((fact) => `${fact.label}: ${fact.value}`)
    .join("\n");
  const message = payload.body ? plainNotificationText(payload.body) : "";
  // A notification with no message of its own carries its title as the body;
  // show the title once.
  const lines = [message === payload.title ? "" : message, facts].filter(Boolean);
  const body = lines.join("\n\n");
  return {
    title: payload.title ?? fallback,
    ...(payload.subtitle ? { subtitle: payload.subtitle } : {}),
    ...(body || payload.rule !== "agent" ? { body: body || fallback } : {}),
  };
}

/**
 * Questions and approvals, and agent notifications marked time-sensitive,
 * break through Focus; everything else arrives quietly in its usual place.
 */
export function nativePushInterruptionLevel(
  payload: ClaimedNativePushDelivery["payload"],
): "time-sensitive" | "active" {
  if (payload.rule === "needs_input") return "time-sensitive";
  if (payload.rule === "agent" && payload.urgency === "time_sensitive") return "time-sensitive";
  return "active";
}

/** What the app reads on tap: enough to open the session in the right account. */
export function nativePushData(payload: ClaimedNativePushDelivery["payload"]) {
  return {
    sessionId: payload.sessionId,
    workspaceId: payload.workspaceId,
    subjectId: payload.subjectId,
    rule: payload.rule,
    ...(payload.eventType ? { eventType: payload.eventType } : {}),
    ...(payload.sequence ? { sequence: payload.sequence } : {}),
  };
}

/**
 * The notification category the app registers actions for: an approval can be
 * approved (behind device unlock) or denied, a question answered inline.
 */
export function nativePushCategory(
  payload: ClaimedNativePushDelivery["payload"],
): "og.approval" | "og.question" | undefined {
  if (payload.eventType === "session.requiresAction") return "og.approval";
  if (payload.eventType === "session.humanInput.requested") return "og.question";
  return undefined;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signJwt(
  header: Record<string, string>,
  claims: Record<string, unknown>,
  privateKey: string,
  algorithm: "ES256" | "RS256",
): string {
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signer = createSign("SHA256");
  signer.update(unsigned);
  const signature =
    algorithm === "ES256"
      ? signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" })
      : signer.sign(privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

function pem(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/gu, "\n") : value;
}

/** APNs with a token-based (.p8) key; one HTTP/2 connection per environment. */
export function createApnsSender(input: {
  keyId: string;
  teamId: string;
  privateKey: string;
}): NativePushSender {
  const key = pem(input.privateKey);
  let token: { value: string; issuedAt: number } | null = null;
  const sessions = new Map<string, ClientHttp2Session>();
  const bearer = () => {
    const now = Math.floor(Date.now() / 1000);
    // Apple accepts a provider token for an hour and rejects refreshes more
    // often than every 20 minutes.
    if (!token || now - token.issuedAt > 40 * 60) {
      token = {
        value: signJwt(
          { alg: "ES256", kid: input.keyId },
          { iss: input.teamId, iat: now },
          key,
          "ES256",
        ),
        issuedAt: now,
      };
    }
    return token.value;
  };
  const session = (host: string) => {
    const existing = sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const created = connect(`https://${host}`);
    created.on("error", () => sessions.delete(host));
    created.on("close", () => sessions.delete(host));
    sessions.set(host, created);
    return created;
  };
  return async (delivery) => {
    const host =
      delivery.environment === "development" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
    const alert = nativePushAlert(delivery.payload);
    const category = nativePushCategory(delivery.payload);
    const body = JSON.stringify({
      aps: {
        alert,
        sound: "default",
        "thread-id": delivery.payload.sessionId,
        "interruption-level": nativePushInterruptionLevel(delivery.payload),
        ...(category ? { category } : {}),
      },
      body: nativePushData(delivery.payload),
    });
    return await new Promise<NativePushSendResult>((resolve) => {
      const request = session(host).request({
        ":method": "POST",
        ":path": `/3/device/${delivery.token}`,
        authorization: `bearer ${bearer()}`,
        "apns-topic": delivery.appId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": `${delivery.payload.sessionId}:${delivery.payload.rule}`.slice(0, 64),
        "content-type": "application/json",
      });
      let status = 0;
      let text = "";
      request.setTimeout(10_000, () => request.close());
      request.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      request.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      request.on("error", (error) => resolve({ outcome: "retry", error: String(error) }));
      request.on("close", () => {
        if (status === 200) return resolve({ outcome: "delivered" });
        const reason = (() => {
          try {
            return (JSON.parse(text) as { reason?: string }).reason ?? text;
          } catch {
            return text || `status ${status}`;
          }
        })();
        if (status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") {
          return resolve({ outcome: "unregistered", error: `${status} ${reason}` });
        }
        resolve({
          outcome: status === 429 || status >= 500 || status === 0 ? "retry" : "failed",
          error: `${status} ${reason}`,
        });
      });
      request.end(body);
    });
  };
}

/** FCM HTTP v1 with a service account; data-only, so the app presents it. */
export function createFcmSender(input: {
  serviceAccountJson: string;
  fetch?: typeof fetch;
}): NativePushSender {
  const account = JSON.parse(input.serviceAccountJson) as {
    project_id: string;
    client_email: string;
    private_key: string;
    token_uri?: string;
  };
  const http = input.fetch ?? fetch;
  let access: { token: string; expiresAt: number } | null = null;
  const accessToken = async () => {
    if (access && access.expiresAt - 60_000 > Date.now()) return access.token;
    const now = Math.floor(Date.now() / 1000);
    const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
    const assertion = signJwt(
      { alg: "RS256", typ: "JWT" },
      {
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      },
      pem(account.private_key),
      "RS256",
    );
    const response = await http(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) throw new Error(`FCM token exchange failed: ${response.status}`);
    const json = (await response.json()) as { access_token: string; expires_in: number };
    access = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return access.token;
  };
  return async (delivery) => {
    try {
      const alert = nativePushAlert(delivery.payload);
      const response = await http(
        `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: delivery.token,
              android: { priority: "HIGH", collapse_key: delivery.payload.sessionId },
              data: {
                title: alert.title,
                message: [alert.subtitle, alert.body].filter(Boolean).join("\n") || alert.title,
                body: JSON.stringify(nativePushData(delivery.payload)),
              },
            },
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.ok) return { outcome: "delivered" };
      const text = await response.text();
      if (response.status === 404 || text.includes("UNREGISTERED")) {
        return { outcome: "unregistered", error: `${response.status} ${text.slice(0, 200)}` };
      }
      return {
        outcome: response.status === 429 || response.status >= 500 ? "retry" : "failed",
        error: `${response.status} ${text.slice(0, 200)}`,
      };
    } catch (error) {
      return { outcome: "retry", error: String(error).slice(0, 300) };
    }
  };
}

/** The senders this deployment has credentials for. */
export function configuredNativePushSenders(
  settings: Settings,
): Partial<Record<"ios" | "android", NativePushSender>> {
  const senders: Partial<Record<"ios" | "android", NativePushSender>> = {};
  if (settings.apnsKeyId && settings.apnsTeamId && settings.apnsPrivateKey) {
    senders.ios = createApnsSender({
      keyId: settings.apnsKeyId,
      teamId: settings.apnsTeamId,
      privateKey: settings.apnsPrivateKey,
    });
  }
  if (settings.fcmServiceAccountJson) {
    senders.android = createFcmSender({ serviceAccountJson: settings.fcmServiceAccountJson });
  }
  return senders;
}

export async function drainNativePushDeliveries(
  deps: NativePushDispatchDeps,
): Promise<{ claimed: number; delivered: number }> {
  const senders = deps.senders ?? configuredNativePushSenders(deps.settings);
  const claimId = randomUUID();
  const claimed = await claimNativePushDeliveries(deps.db, {
    claimId,
    limit: 32,
    claimSeconds: CLAIM_SECONDS,
  });
  let delivered = 0;
  await Promise.all(
    claimed.map(async (delivery) => {
      const sender = senders[delivery.platform];
      const result: NativePushSendResult = sender
        ? await sender(delivery).catch((error: unknown) => ({
            outcome: "retry" as const,
            error: String(error),
          }))
        : { outcome: "failed", error: `No ${delivery.platform} push credentials configured` };
      const outcome =
        result.outcome === "retry" && delivery.attempts >= MAX_ATTEMPTS ? "failed" : result.outcome;
      if (outcome === "delivered") delivered += 1;
      else
        deps.observability?.warn("Native push not delivered", {
          platform: delivery.platform,
          outcome,
          error: result.error,
        });
      await settleNativePushDelivery(deps.db, {
        claimId,
        deliveryId: delivery.deliveryId,
        outcome,
        error: result.error ?? null,
        retrySeconds: Math.min(3600, 5 * 2 ** delivery.attempts),
      });
    }),
  );
  return { claimed: claimed.length, delivered };
}

export function startNativePushDispatchPump(deps: NativePushDispatchDeps): () => Promise<void> {
  const senders = deps.senders ?? configuredNativePushSenders(deps.settings);
  let stopped = false;
  let ticks = 0;
  let running: Promise<void> | null = null;
  const tick = async () => {
    ticks += 1;
    try {
      const { claimed } = await drainNativePushDeliveries({ ...deps, senders });
      if (claimed > 0) deps.observability?.info("Native push batch", { claimed });
      if (ticks % PRUNE_EVERY_TICKS === 0) await pruneNativePushDeliveries(deps.db);
    } catch (error) {
      deps.observability?.error("Native push dispatch failed", { error: String(error) });
    }
  };
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = tick().finally(() => {
      running = null;
    });
  }, POLL_INTERVAL_MS);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
