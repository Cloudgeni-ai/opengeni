import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Settings } from "@opengeni/config";
import { normalizeConversationInboundEnvelope } from "@opengeni/core";

const uuid = z.string().uuid();
const opaque = z.string().min(1).max(512);
const Activity = z.object({
  type: z.literal("message"),
  id: opaque,
  timestamp: z.string().datetime({ offset: true }),
  channelId: z.literal("msteams"),
  serviceUrl: z.string().url(),
  from: z.object({ id: opaque, aadObjectId: uuid, role: z.string().optional() }),
  recipient: z.object({ id: opaque }),
  conversation: z.object({
    id: opaque,
    conversationType: z.enum(["personal", "channel"]),
    tenantId: uuid.optional(),
  }),
  channelData: z.object({
    tenant: z.object({ id: uuid }),
    channel: z.object({ id: opaque }).optional(),
  }),
  replyToId: opaque.optional(),
  text: z.string().max(32768).default(""),
  entities: z
    .array(
      z
        .object({
          type: z.string(),
          mentioned: z.object({ id: z.string() }).optional(),
          text: z.string().optional(),
        })
        .passthrough(),
    )
    .max(100)
    .optional(),
  attachments: z.array(z.unknown()).max(16).optional(),
});
export type TeamsMessage = {
  tenantId: string;
  actorId: string;
  channelId: string | null;
  conversationId: string;
  threadId: string | null;
  serviceUrl: string;
  botId: string;
  eventId: string;
  personal: boolean;
  text: string;
  occurredAt: string;
  identity: string;
  routeIdentity: string;
};

/** DM ownership changes get a fresh session without moving the former human's history. */
export function teamsRouteId(
  message: Pick<TeamsMessage, "personal" | "routeIdentity">,
  generation: string,
  subjectId: string,
): string {
  return message.personal
    ? createHash("sha256")
        .update(JSON.stringify([message.routeIdentity, generation, subjectId]))
        .digest("hex")
    : `${message.routeIdentity}:${generation}`;
}
export function teamsBotConfigured(s: Settings): boolean {
  return Boolean(
    s.teamsBotClientId && s.teamsBotClientSecret && s.teamsBotTenantId && s.integrationsStateSecret,
  );
}
export function teamsTenantEnabled(s: Settings, tenantId: string): boolean {
  return (
    teamsBotConfigured(s) &&
    (s.teamsBotEnabled ||
      s.teamsBotAllowedTenantIds.some((id) => id.toLowerCase() === tenantId.toLowerCase()))
  );
}
/** Accept public-cloud Teams connector URLs only, even after SDK signature validation. */
export function teamsServiceUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !(
      url.hostname === "smba.trafficmanager.net" ||
      url.hostname.endsWith(".smba.trafficmanager.net") ||
      url.hostname === "smba.infra.teams.microsoft.com" ||
      url.hostname.endsWith(".smba.infra.teams.microsoft.com")
    )
  ) {
    throw new Error("teams_service_url_rejected");
  }
  return url.toString();
}
/** Called only by the SDK's authenticated activity callback, never raw HTTP JSON. */
export function normalizeTeamsMessage(raw: unknown): TeamsMessage | null {
  const parsed = Activity.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  if (a.from.role === "bot" || a.from.id === a.recipient.id || a.attachments?.length) return null;
  const tenantId = a.channelData.tenant.id.toLowerCase();
  if (a.conversation.tenantId && a.conversation.tenantId.toLowerCase() !== tenantId) return null;
  const personal = a.conversation.conversationType === "personal";
  if (!personal && !a.channelData.channel?.id) return null;
  let text = a.text;
  const mentions = (a.entities ?? []).filter(
    (e) => e.type === "mention" && e.mentioned?.id === a.recipient.id,
  );
  // Channel messages must explicitly invoke the bot. Never ambient-listen to a channel.
  if (!personal && !mentions.length) return null;
  for (const mention of mentions) if (mention.text) text = text.replace(mention.text, "");
  text = text.trim();
  if (!text) return null;
  const threadId = personal ? null : (a.replyToId ?? a.id);
  const envelope = normalizeConversationInboundEnvelope({
    provider: "microsoft.teams",
    installationId: tenantId,
    actor: { providerActorId: a.from.aadObjectId.toLowerCase(), kind: "human" },
    route: { providerConversationId: a.conversation.id, providerThreadId: threadId },
    providerEventId: a.id,
    providerMessageId: a.id,
    occurredAt: new Date(a.timestamp).toISOString(),
    signal: { kind: "continue" },
    text,
  });
  return {
    tenantId,
    actorId: a.from.aadObjectId.toLowerCase(),
    channelId: personal ? null : a.channelData.channel!.id,
    conversationId: a.conversation.id,
    threadId,
    serviceUrl: teamsServiceUrl(a.serviceUrl),
    botId: a.recipient.id,
    eventId: a.id,
    personal,
    text,
    occurredAt: a.timestamp,
    identity: envelope.eventIdentity,
    routeIdentity: envelope.route.identity,
  };
}
const Proof = z
  .object({
    version: z.literal(1),
    purpose: z.enum(["setup", "link"]),
    tenantId: uuid,
    actorId: uuid,
    workspaceId: uuid.nullable(),
    generation: uuid.nullable(),
    nonce: uuid,
    expiresAt: z.number().int(),
  })
  .strict();
export type TeamsLinkProof = z.infer<typeof Proof>;
export function mintTeamsProof(
  secret: string,
  input: Omit<TeamsLinkProof, "version" | "nonce" | "expiresAt">,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify(
      Proof.parse({ ...input, version: 1, nonce: randomUUID(), expiresAt: now + 10 * 60_000 }),
    ),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(`teams-link-v1:${payload}`).digest("base64url")}`;
}
export function verifyTeamsProof(secret: string, token: string, now = Date.now()): TeamsLinkProof {
  if (token.length > 4096) throw new Error("teams_link_invalid");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("teams_link_invalid");
  const expected = createHmac("sha256", secret).update(`teams-link-v1:${payload}`).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("teams_link_invalid");
  const proof = Proof.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  if (proof.expiresAt <= now || proof.expiresAt > now + 10 * 60_000)
    throw new Error("teams_link_expired");
  return proof;
}
