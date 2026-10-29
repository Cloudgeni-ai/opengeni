import type { App } from "@microsoft/teams.apps";
import type { Hono, Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AccessGrant } from "@opengeni/contracts";
import { turnCompletedReply } from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  hasPermission,
  createSessionForRequest,
  acceptSessionUserMessage,
  requireSessionAuthorization,
  withResolvedSessionAuthorization,
  resolveWorkspaceCatalogSettings,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getSessionAuthorityProjection,
  withSessionRlsActorContext,
  getWorkspace,
  getWorkspaceGrant,
  namedSubjectHasLiveWorkspaceAuthority,
  namedSubjectPersonalWorkspaceId,
  personalWorkspaceClosedToNewWork,
  resolveNamedManagedPersonalWorkspaceGrant,
  getTeamsInstallation,
  invalidateTeamsGroup,
  teamsGroupRouteActive,
  type TeamsGroupAudience,
  getWorkspaceTeamsInstallation,
  listTeamsInstallations,
  installTeamsBot,
  linkTeamsActor,
  getTeamsActor,
  getOwnTeamsLink,
  removeTeamsLink,
  disconnectTeamsBot,
  enqueueTeamsMessage,
  claimTeamsRoute,
  releaseTeamsRoute,
  getTeamsPendingMessage,
  settleTeamsMessage,
  enqueueTeamsOutput,
  claimTeamsOutput,
  settleTeamsOutput,
  listSessionEventPage,
  renewTeamsRoute,
  teamsDeliveryStatus,
  refuseTeamsRouteOutputs,
  type TeamsInstallation,
  type TeamsRoute,
} from "@opengeni/db";
import { parseRequestJson } from "../http/request-body";
import { disconnectAuditActor } from "../http/disconnect-audit-actor";
import {
  teamsBotConfigured,
  teamsTenantEnabled,
  teamsServiceUrl,
  normalizeTeamsMessage,
  teamsRouteId,
  mintTeamsProof,
  verifyTeamsProof,
  type TeamsMessage,
} from "./teams-protocol";

import {
  resolveTeamsGroupAudience,
  sameTeamsAudience,
  teamsGroupMembershipChange,
} from "./teams-group";

const ENDPOINT = "/v1/integrations/teams/messages";
const ROOT = "/v1/workspaces/:workspaceId/integrations/teams";
const inventoryCursors = new WeakMap<ApiRouteDeps, string>();
const runtimes = new WeakMap<ApiRouteDeps, Promise<App>>();

function configuredBase(deps: ApiRouteDeps): string {
  const base = deps.settings.webBaseUrl ?? deps.settings.publicBaseUrl;
  if (!base) throw new Error("teams_public_url_missing");
  return base;
}
function proofLink(deps: ApiRouteDeps, m: TeamsMessage, i: TeamsInstallation | null): string {
  const purpose = i ? "link" : "setup";
  const token = mintTeamsProof(deps.settings.integrationsStateSecret!, {
    purpose,
    tenantId: m.tenantId,
    actorId: m.actorId,
    workspaceId: i?.workspace_id ?? null,
    generation: i?.generation ?? null,
  });
  const url = new URL(
    i ? `/workspaces/${i.workspace_id}/plugins` : "/teams/connect",
    configuredBase(deps),
  );
  url.hash = new URLSearchParams({ [i ? "teams_link" : "teams_setup"]: token }).toString();
  return url.toString();
}
function sessionUrl(deps: ApiRouteDeps, r: TeamsRoute): string {
  return new URL(
    `/workspaces/${routeSessionWorkspace(r)}/sessions/${r.session_id}`,
    configuredBase(deps),
  ).toString();
}
/** The workspace a route's session lives in. */
function routeSessionWorkspace(r: TeamsRoute): string {
  return r.session_workspace_id ?? r.workspace_id;
}
async function send(
  app: App,
  m: Pick<TeamsMessage, "serviceUrl" | "conversationId" | "threadId" | "botId">,
  text: string,
): Promise<string> {
  const client = app.api.fromServiceUrl({ serviceUrl: teamsServiceUrl(m.serviceUrl) });
  const conversationId =
    m.threadId && !m.conversationId.includes(";messageid=")
      ? `${m.conversationId};messageid=${m.threadId}`
      : m.conversationId;
  const response = await client.conversations.createActivity(conversationId, {
    type: "message",
    text,
    textFormat: "plain",
    ...(m.threadId ? { replyToId: m.threadId } : {}),
  });
  if (!response.id) throw new Error("teams_delivery_missing_receipt");
  return response.id;
}
/** Only stored, cryptographically linked actors reach this grant resolver. */
async function actorGrant(
  deps: ApiRouteDeps,
  i: TeamsInstallation,
  actorId: string,
): Promise<AccessGrant | null> {
  const subjectId = await getTeamsActor(deps.db, i, actorId);
  if (!subjectId) return null;
  const grant = await getWorkspaceGrant(deps.db, subjectId, i.workspace_id, {
    principalKind: "human_session",
  });
  if (!grant || grant.accountId !== i.account_id) return null;
  if (
    !(await namedSubjectHasLiveWorkspaceAuthority(deps.db, {
      accountId: i.account_id,
      workspaceId: i.workspace_id,
      subjectId,
    }))
  )
    return null;
  return grant;
}
/** The linked person's own Personal workspace grant, when they have one in
 * this organization, may start chats there, and Personal workspaces are on.
 * The workspace comes from their active membership pointer, never Teams. */
async function ownPersonalWorkspaceGrant(
  deps: ApiRouteDeps,
  i: TeamsInstallation,
  subjectId: string,
  workspaceId?: string,
): Promise<AccessGrant | null> {
  const personal = await namedSubjectPersonalWorkspaceId(deps.db, {
    accountId: i.account_id,
    subjectId,
  });
  if (!personal || personal === i.workspace_id || (workspaceId && personal !== workspaceId))
    return null;
  return await resolveNamedManagedPersonalWorkspaceGrant(deps.db, {
    accountId: i.account_id,
    workspaceId: personal,
    subjectId,
  });
}
/** Where a new 1:1 chat from this linked person lands: their own Personal
 * workspace while they can start chats there, as a Slack bot DM does. */
export async function teamsChatPersonalWorkspace(
  deps: ApiRouteDeps,
  i: TeamsInstallation,
  subjectId: string,
): Promise<string | null> {
  const grant = await ownPersonalWorkspaceGrant(deps, i, subjectId);
  if (
    !grant ||
    !hasPermission(grant.permissions, "sessions:create") ||
    (await personalWorkspaceClosedToNewWork(deps.db, {
      accountId: i.account_id,
      workspaceId: grant.workspaceId,
    }))
  )
    return null;
  return grant.workspaceId;
}
/** The grant a route's session work uses: the installation workspace's, or
 * for a 1:1 chat in the person's Personal workspace, that workspace's. */
async function routeSessionGrant(
  deps: ApiRouteDeps,
  i: TeamsInstallation,
  r: TeamsRoute,
  identity: AccessGrant,
): Promise<AccessGrant | null> {
  if (!r.session_workspace_id) return identity;
  if (!r.personal || identity.subjectId !== r.subject_id) return null;
  return await ownPersonalWorkspaceGrant(deps, i, identity.subjectId, r.session_workspace_id);
}
export type TeamsRosterReader = (m: {
  serviceUrl: string;
  conversationId: string;
  botId: string;
}) => Promise<unknown>;
async function groupAudience(
  deps: ApiRouteDeps,
  i: TeamsInstallation,
  m: { serviceUrl: string; conversationId: string; botId: string },
  read: TeamsRosterReader,
): Promise<TeamsGroupAudience> {
  return resolveTeamsGroupAudience(await read(m), i.tenant_id, m.botId, async (actorId) => {
    const grant = await actorGrant(deps, i, actorId);
    return grant && hasPermission(grant.permissions, "sessions:read") ? grant.subjectId : null;
  });
}
async function readGroupRoster(
  deps: ApiRouteDeps,
  m: { serviceUrl: string; conversationId: string },
): Promise<unknown> {
  return (await runtime(deps)).api
    .fromServiceUrl({ serviceUrl: teamsServiceUrl(m.serviceUrl) })
    .conversations.getMembers(m.conversationId);
}
async function runtime(deps: ApiRouteDeps): Promise<App> {
  let pending = runtimes.get(deps);
  if (!pending) {
    pending = (async () => {
      const { App } = await import("@microsoft/teams.apps");
      const app = new App({
        clientId: deps.settings.teamsBotClientId!,
        clientSecret: deps.settings.teamsBotClientSecret!,
        tenantId: deps.settings.teamsBotTenantId!,
        client: { timeout: 20_000 },
        messagingEndpoint: ENDPOINT,
        httpServerAdapter: {
          registerRoute() {
            /* Hono owns the HTTP listener. */
          },
        },
      });
      await app.initialize();
      // The SDK invokes this only after validating the Connector JWT, audience,
      // issuer, expiry and service URL. Never pass a pre-authenticated request token.
      app.server.onRequest = async ({ body }) => {
        const observed = (reason: string) =>
          deps.observability?.info("Teams authenticated activity outcome", { reason });
        const change = teamsGroupMembershipChange(
          body,
          `28:${deps.settings.teamsBotClientId!.toLowerCase()}`,
        );
        if (change) {
          const installation = await getTeamsInstallation(deps.db, change.tenantId);
          if (installation?.active)
            await invalidateTeamsGroup(deps.db, installation, change.conversationId);
          return { status: 200 };
        }
        const m = normalizeTeamsMessage(body, (diagnostic) => {
          deps.observability?.info("Teams authenticated activity ignored", { ...diagnostic });
        });
        if (!m) return { status: 200 };
        if (m.botId.toLowerCase() !== `28:${deps.settings.teamsBotClientId!.toLowerCase()}`) {
          observed("bot_identity_mismatch");
          return { status: 200 };
        }
        if (!teamsTenantEnabled(deps.settings, m.tenantId)) {
          observed("tenant_disabled");
          return { status: 200 };
        }
        if (
          !m.personal &&
          !(m.groupChat
            ? deps.settings.teamsBotAllowedGroupChatIds.includes(
                `${m.tenantId}:${m.conversationId}`,
              )
            : deps.settings.teamsBotAllowedChannelIds.includes(`${m.tenantId}:${m.channelId}`))
        ) {
          observed("channel_disabled");
          return { status: 200 };
        }
        const i = await getTeamsInstallation(deps.db, m.tenantId);
        if (!i?.active) {
          if (
            m.personal &&
            deps.settings.teamsBotSetupAdminIds.includes(`${m.tenantId}:${m.actorId}`)
          ) {
            await send(app, m, `Connect Teams to Opengeni: ${proofLink(deps, m, null)}`);
            observed("setup_link_sent");
          } else observed("setup_not_permitted");
          return { status: 200 };
        }
        const grant = await actorGrant(deps, i, m.actorId);
        if (!grant) {
          // Identity bearers are never sent to channels or shared conversations.
          if (m.personal)
            await send(
              app,
              m,
              `Link your Opengeni account to use this bot: ${proofLink(deps, m, i)}`,
            );
          else
            await send(
              app,
              m,
              "Send me a direct message to link your Opengeni account, then mention me here again.",
            );
          return { status: 200 };
        }
        if (!hasPermission(grant.permissions, "sessions:create")) return { status: 200 };
        let audience: TeamsGroupAudience | undefined;
        if (m.groupChat) {
          try {
            audience = await groupAudience(deps, i, m, async (value) =>
              app.api
                .fromServiceUrl({ serviceUrl: teamsServiceUrl(value.serviceUrl) })
                .conversations.getMembers(value.conversationId),
            );
            if (!audience.some((x) => x.actorId === m.actorId && x.subjectId === grant.subjectId))
              throw new Error("teams_group_sender_missing");
          } catch {
            await invalidateTeamsGroup(deps.db, i, m.conversationId, {
              revision: i.group_revision,
            });
            await send(
              app,
              m,
              "I couldn’t verify this chat’s access. Everyone needs workspace access and a linked Opengeni account. Message me privately to connect, then @mention me here.",
            );
            return { status: 200 };
          }
        }
        // A 1:1 chat lands in the sender's own Personal workspace; channels
        // and group chats stay in the installation's workspace.
        const sessionWorkspaceId = m.personal
          ? await teamsChatPersonalWorkspace(deps, i, grant.subjectId)
          : null;
        await enqueueTeamsMessage(deps.db, i, {
          routeId: teamsRouteId(m, i.generation, grant.subjectId, sessionWorkspaceId),
          actorId: m.actorId,
          subjectId: grant.subjectId,
          personal: m.personal,
          sessionWorkspaceId,
          channelId: m.channelId,
          ...(audience ? { groupAudience: audience, groupRevision: i.group_revision } : {}),
          conversationId: m.conversationId,
          threadId: m.threadId,
          serviceUrl: m.serviceUrl,
          botId: m.botId,
          eventId: `${m.identity}:${i.generation}`,
          payload: m,
        });
        return { status: 200 };
      };
      return app;
    })();
    runtimes.set(deps, pending);
  }
  return pending;
}
async function browserHuman(c: Context, deps: ApiRouteDeps) {
  if (c.req.header("authorization"))
    throw new HTTPException(401, {
      message: "Sign in with your Opengeni account to connect Teams.",
    });
  const authorization = await requireAccessGrantAuthorization(c, deps, c.req.param("workspaceId")!);
  if (!authorization.canonicalManagedHumanSession)
    throw new HTTPException(403, { message: "A signed-in human account is required." });
  return authorization.grant;
}
function proof(deps: ApiRouteDeps, token: string) {
  if (!teamsBotConfigured(deps.settings))
    throw new HTTPException(404, { message: "Teams is not enabled." });
  try {
    return verifyTeamsProof(deps.settings.integrationsStateSecret!, token);
  } catch {
    throw new HTTPException(400, {
      message: "This Teams link is invalid or expired. Send the bot a new direct message.",
    });
  }
}
async function status(deps: ApiRouteDeps, workspaceId: string, subjectId: string) {
  const i = await getWorkspaceTeamsInstallation(deps.db, workspaceId);
  const configured = teamsBotConfigured(deps.settings);
  const enabled = i
    ? teamsTenantEnabled(deps.settings, i.tenant_id)
    : deps.settings.teamsBotEnabled || deps.settings.teamsBotAllowedTenantIds.length > 0;
  return {
    enabled,
    configured,
    setupAvailable: configured && enabled && deps.settings.teamsBotSetupAdminIds.length > 0,
    installation: i
      ? { tenantId: i.tenant_id, workspaceId: i.workspace_id, active: i.active }
      : null,
    delivery: i
      ? await teamsDeliveryStatus(deps.db, i, subjectId)
      : { pending: 0, unknown: 0, failed: 0 },
    linked: Boolean(i?.active && (await getOwnTeamsLink(deps.db, i, subjectId))),
  };
}
export function registerTeamsBotRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.post(ENDPOINT, bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    if (
      !teamsBotConfigured(deps.settings) ||
      (!deps.settings.teamsBotEnabled && !deps.settings.teamsBotAllowedTenantIds.length)
    )
      return c.json({ error: "Teams is not enabled" }, 404);
    // Narrow the SDK's accepted issuer families to the classic Teams Connector.
    // This untrusted decode grants nothing: the SDK still verifies signature,
    // audience, issuer, expiry, and the signed service URL below.
    const bearer = c.req.header("authorization")?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1];
    try {
      if (
        !bearer ||
        bearer.length > 16384 ||
        JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString("utf8")).iss !==
          "https://api.botframework.com"
      )
        return c.json({ error: "Invalid Connector token" }, 401);
    } catch {
      return c.json({ error: "Invalid Connector token" }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid activity" }, 400);
    }
    const result = await (
      await runtime(deps)
    ).server.handleRequest({ body, headers: Object.fromEntries(c.req.raw.headers.entries()) });
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  });
  app.get(`${ROOT}/bot`, async (c) => {
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId"), "connections:read");
    return c.json(await status(deps, grant.workspaceId, grant.subjectId));
  });
  app.put(`${ROOT}/bot`, async (c) => {
    const human = await browserHuman(c, deps);
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId"), "workspace:admin");
    if (grant.subjectId !== human.subjectId) throw new HTTPException(403);
    const { setupToken } = await parseRequestJson(
      c,
      z.object({ setupToken: z.string().max(4096) }).strict(),
    );
    const p = proof(deps, setupToken);
    if (
      p.purpose !== "setup" ||
      p.workspaceId !== null ||
      p.generation !== null ||
      !teamsTenantEnabled(deps.settings, p.tenantId) ||
      !deps.settings.teamsBotSetupAdminIds.includes(`${p.tenantId}:${p.actorId}`)
    )
      throw new HTTPException(403, {
        message: "This Teams identity is not approved to install the bot.",
      });
    const workspace = await getWorkspace(deps.db, grant.workspaceId);
    if (workspace?.kind !== "shared")
      throw new HTTPException(422, { message: "Install the Teams bot in a shared workspace." });
    const existingTenant = await getTeamsInstallation(deps.db, p.tenantId);
    if (existingTenant && existingTenant.workspace_id !== grant.workspaceId)
      throw new HTTPException(409, {
        message:
          "This Teams organization is linked to another workspace. Reconnect it in that workspace.",
      });
    const existingWorkspace = await getWorkspaceTeamsInstallation(deps.db, grant.workspaceId);
    if (existingWorkspace && existingWorkspace.tenant_id !== p.tenantId)
      throw new HTTPException(409, {
        message: "This workspace is linked to another Teams organization.",
      });
    try {
      await installTeamsBot(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        tenantId: p.tenantId,
        actorId: p.actorId,
        subjectId: grant.subjectId,
        nonce: p.nonce,
      });
    } catch (error) {
      const cause = error as { code?: string; cause?: { code?: string }; message?: string };
      if (cause.message === "teams_tenant_already_bound")
        throw new HTTPException(409, {
          message:
            "This Teams organization is linked to another workspace. Reconnect it in that workspace.",
        });
      if (
        cause.message === "teams_identity_already_linked" ||
        cause.code === "23505" ||
        cause.cause?.code === "23505"
      )
        throw new HTTPException(409, {
          message:
            "This Teams link was already used or the account is already connected. Send the bot a new direct message to continue.",
        });
      throw error;
    }
    return c.json(await status(deps, grant.workspaceId, grant.subjectId));
  });
  app.delete(`${ROOT}/bot`, async (c) => {
    await browserHuman(c, deps);
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId"), "workspace:admin");
    const i = await getWorkspaceTeamsInstallation(deps.db, grant.workspaceId);
    if (i)
      await disconnectTeamsBot(deps.db, i, {
        audit: disconnectAuditActor(c, { subjectId: grant.subjectId, grant }),
      });
    return c.json({ ok: true });
  });
  app.post(`${ROOT}/link`, async (c) => {
    const human = await browserHuman(c, deps);
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId"), "sessions:create");
    if (grant.subjectId !== human.subjectId) throw new HTTPException(403);
    const { token } = await parseRequestJson(c, z.object({ token: z.string().max(4096) }).strict());
    const p = proof(deps, token);
    const i = await getWorkspaceTeamsInstallation(deps.db, grant.workspaceId);
    if (
      p.purpose !== "link" ||
      p.workspaceId !== grant.workspaceId ||
      !i?.active ||
      i.tenant_id !== p.tenantId ||
      i.generation !== p.generation ||
      !teamsTenantEnabled(deps.settings, p.tenantId)
    )
      throw new HTTPException(403, {
        message: "This Teams link does not match the current workspace installation.",
      });
    await linkTeamsActor(deps.db, i, {
      actorId: p.actorId,
      subjectId: grant.subjectId,
      nonce: p.nonce,
    });
    return c.json({ ok: true });
  });
  app.delete(`${ROOT}/link`, async (c) => {
    await browserHuman(c, deps);
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId"), "sessions:read");
    const i = await getWorkspaceTeamsInstallation(deps.db, grant.workspaceId);
    if (i) await removeTeamsLink(deps.db, i, grant.subjectId);
    return c.json({ ok: true });
  });
}

async function currentInstallation(deps: ApiRouteDeps, i: TeamsInstallation): Promise<boolean> {
  if (!teamsTenantEnabled(deps.settings, i.tenant_id)) return false;
  const live = await getTeamsInstallation(deps.db, i.tenant_id);
  return Boolean(
    live?.active && live.generation === i.generation && live.workspace_id === i.workspace_id,
  );
}
async function catalogDeps(deps: ApiRouteDeps, grant: AccessGrant): Promise<ApiRouteDeps> {
  const source = deps.catalogSourceSettings ?? deps.settings;
  return {
    ...deps,
    catalogSourceSettings: source,
    settings: (
      await resolveWorkspaceCatalogSettings(deps.db, source, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
      })
    ).settings,
  };
}
export function teamsTextParts(text: string): string[] {
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const c of text) {
    const size = Buffer.byteLength(c);
    if (bytes + size > 20_000) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    part += c;
    bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}
type TeamsSender = (
  message: Pick<TeamsMessage, "serviceUrl" | "conversationId" | "threadId" | "botId">,
  text: string,
) => Promise<string>;
function admissionNotice(
  deps: ApiRouteDeps,
  r: TeamsRoute,
  kind: "admission" | "audience_changed",
): string {
  const url = new URL(`/workspaces/${r.workspace_id}/plugins`, configuredBase(deps)).toString();
  return kind === "audience_changed"
    ? `This chat's visibility changed, so your message was not added. Continue in Opengeni: ${url}`
    : `Opengeni could not start this task. Check your workspace access and chat settings: ${url}`;
}
async function drainRoute(
  deps: ApiRouteDeps,
  i: TeamsInstallation,
  r: TeamsRoute,
  deliver: TeamsSender,
  readRoster: TeamsRosterReader,
): Promise<void> {
  if (
    !(await currentInstallation(deps, i)) ||
    (!r.personal &&
      !(r.group_audience
        ? deps.settings.teamsBotAllowedGroupChatIds.includes(`${i.tenant_id}:${r.conversation_id}`)
        : deps.settings.teamsBotAllowedChannelIds.includes(`${i.tenant_id}:${r.channel_id}`)))
  )
    return;
  const verifyGroup = async () => {
    if (!r.group_audience) return true;
    try {
      if (!r.group_active) throw new Error("teams_group_inactive");
      const audience = await groupAudience(
        deps,
        i,
        { serviceUrl: r.service_url, conversationId: r.conversation_id, botId: r.bot_id },
        readRoster,
      );
      if (
        !sameTeamsAudience(r.group_audience, audience) ||
        !(await teamsGroupRouteActive(deps.db, i, r))
      )
        throw new Error("teams_group_audience_changed");
      return true;
    } catch {
      await invalidateTeamsGroup(deps.db, i, r.conversation_id, {
        routeId: r.route_id,
        leaseToken: r.lease_token,
      });
      await refuseTeamsRouteOutputs(deps.db, i, r, "teams_group_audience_changed");
      return false;
    }
  };
  if (!(await verifyGroup())) return;
  const inbound = await getTeamsPendingMessage(deps.db, i, r);
  if (inbound) {
    const identity = await actorGrant(deps, i, inbound.actor_id);
    const grant = identity && (await routeSessionGrant(deps, i, r, identity));
    if (
      !identity ||
      !grant ||
      grant.subjectId !== inbound.subject_id ||
      !hasPermission(grant.permissions, "sessions:create") ||
      (r.personal && grant.subjectId !== r.subject_id)
    ) {
      await settleTeamsMessage(deps.db, i, r, inbound.event_id, "teams_actor_access_revoked");
      return;
    }
    const text = inbound.payload.text;
    if (typeof text !== "string") throw new Error("teams_inbox_payload_invalid");
    const scoped = await catalogDeps(deps, grant);
    const admissionActor = await actorGrant(deps, i, inbound.actor_id);
    if (
      !(await currentInstallation(deps, i)) ||
      admissionActor?.subjectId !== inbound.subject_id ||
      !(await renewTeamsRoute(deps.db, i, r))
    )
      return;
    try {
      if (!r.session_bound) {
        // Personal workspaces were turned off after this 1:1 route was made:
        // refuse with the admission notice; the next message starts in the
        // installation's workspace.
        if (
          r.session_workspace_id &&
          (await personalWorkspaceClosedToNewWork(deps.db, {
            accountId: i.account_id,
            workspaceId: r.session_workspace_id,
          }))
        )
          throw new HTTPException(403, { message: "personal_workspace_closed" });
        await createSessionForRequest(
          scoped,
          grant,
          routeSessionWorkspace(r),
          {
            requestedSessionId: r.session_id,
            initialMessage: text,
            visibility: r.personal ? "private" : "workspace",
            idempotencyKey: `teams:${r.route_id}`,
            clientEventId: inbound.event_id,
            instructions:
              "This conversation is delivered through Microsoft Teams. Reply clearly. Human approvals and private information requests must be completed in the authenticated Opengeni chat.",
          },
          undefined,
          {
            teamsConversation: {
              routeId: r.route_id,
              eventId: inbound.event_id,
              leaseToken: r.lease_token!,
              installationGeneration: i.generation,
            },
          },
        );
      } else {
        await acceptSessionUserMessage(scoped, grant, routeSessionWorkspace(r), r.session_id, {
          text,
          clientEventId: inbound.event_id,
          teamsConversation: {
            routeId: r.route_id,
            eventId: inbound.event_id,
            leaseToken: r.lease_token!,
            installationGeneration: i.generation,
          },
        });
      }
      if (!r.session_bound)
        await enqueueTeamsOutput(deps.db, i, r, 0, [
          `Started. Follow progress or approve requests: ${sessionUrl(deps, r)}`,
        ]);
      await settleTeamsMessage(deps.db, i, r, inbound.event_id, null);
      r.session_bound = true;
    } catch (error) {
      if (error instanceof HTTPException && error.status >= 400 && error.status < 500) {
        const noticeKind =
          error.message === "teams_session_audience_changed" ? "audience_changed" : "admission";
        await enqueueTeamsOutput(deps.db, i, r, -1, [admissionNotice(deps, r, noticeKind)], {
          eventId: inbound.event_id,
          kind: noticeKind,
        });
        await settleTeamsMessage(
          deps.db,
          i,
          r,
          inbound.event_id,
          `session_admission_${error.status}`,
        );
      } else throw error;
    }
  }
  const ownerIdentity = await actorGrant(deps, i, r.actor_id);
  const owner = ownerIdentity && (await routeSessionGrant(deps, i, r, ownerIdentity));
  if (
    !owner ||
    owner.subjectId !== r.subject_id ||
    !hasPermission(owner.permissions, "sessions:read")
  ) {
    await refuseTeamsRouteOutputs(deps.db, i, r, "teams_owner_access_revoked");
    return;
  }
  let output = await claimTeamsOutput(deps.db, i, r, true);
  if (!output) {
    if (r.session_bound) {
      const authorization = await requireSessionAuthorization(deps, owner, {
        sessionId: r.session_id,
        operation: "session.stream.read",
        surface: "core",
      });
      const scope = <T>(fn: () => Promise<T>) =>
        authorization
          ? withResolvedSessionAuthorization(authorization, fn)
          : withSessionRlsActorContext({ subjectId: owner.subjectId }, fn);
      const audience = await scope(() =>
        getSessionAuthorityProjection(deps.db, routeSessionWorkspace(r), r.session_id),
      );
      if (
        !audience ||
        (!r.personal && audience.visibility === "user_private") ||
        (r.personal &&
          (audience.visibility !== "user_private" || audience.ownerSubjectId !== r.subject_id))
      ) {
        await refuseTeamsRouteOutputs(deps.db, i, r, "teams_destination_audience_changed");
        return;
      }
      const page = await scope(() =>
        listSessionEventPage(deps.db, routeSessionWorkspace(r), r.session_id, {
          after: Number(r.delivered_sequence),
          limit: 100,
          maxBytes: 256 * 1024,
        }),
      );
      for (const event of page.events) {
        const payload = event.payload as Record<string, unknown>;
        let text: string | null = null;
        if (event.type === "turn.completed")
          text =
            typeof payload.output === "string" && payload.output.trim()
              ? payload.output
              : turnCompletedReply(payload);
        else if (
          event.type === "session.requiresAction" ||
          event.type === "session.humanInput.requested"
        )
          text = `Your task needs your input or approval. Open the secure Opengeni chat: ${sessionUrl(deps, r)}`;
        else if (event.type === "turn.failed")
          text = `The task could not finish. Open Opengeni for details: ${sessionUrl(deps, r)}`;
        await enqueueTeamsOutput(deps.db, i, r, event.sequence, text ? teamsTextParts(text) : []);
      }
    }
    output = await claimTeamsOutput(deps.db, i, r);
  }
  if (!output) return;
  // Recheck both sides immediately before the external side effect.
  const liveOwnerIdentity = await actorGrant(deps, i, r.actor_id);
  const liveOwner = liveOwnerIdentity && (await routeSessionGrant(deps, i, r, liveOwnerIdentity));
  if (!(await currentInstallation(deps, i)) || !liveOwner || liveOwner.subjectId !== r.subject_id) {
    await settleTeamsOutput(deps.db, i, output.operation_id, {
      state: "failed",
      error: "teams_authority_revoked",
    });
    return;
  }
  if (Number(output.source_sequence) !== -1) {
    const deliveryAuthorization = await requireSessionAuthorization(deps, liveOwner, {
      sessionId: r.session_id,
      operation: "session.stream.read",
      surface: "core",
    });
    const deliveryAudience = await (deliveryAuthorization
      ? withResolvedSessionAuthorization(deliveryAuthorization, () =>
          getSessionAuthorityProjection(deps.db, routeSessionWorkspace(r), r.session_id),
        )
      : withSessionRlsActorContext({ subjectId: liveOwner.subjectId }, () =>
          getSessionAuthorityProjection(deps.db, routeSessionWorkspace(r), r.session_id),
        ));
    if (
      !deliveryAudience ||
      (!r.personal && deliveryAudience.visibility === "user_private") ||
      (r.personal &&
        (deliveryAudience.visibility !== "user_private" ||
          deliveryAudience.ownerSubjectId !== r.subject_id)) ||
      !(await renewTeamsRoute(deps.db, i, r))
    ) {
      await settleTeamsOutput(deps.db, i, output.operation_id, {
        state: "failed",
        error: "teams_delivery_authority_changed",
      });
      return;
    }
  } else if (Number(output.source_sequence) !== -1 || !(await renewTeamsRoute(deps.db, i, r))) {
    await settleTeamsOutput(deps.db, i, output.operation_id, {
      state: "failed",
      error: "teams_unbound_output_refused",
    });
    return;
  }
  if (!(await verifyGroup())) {
    await settleTeamsOutput(deps.db, i, output.operation_id, {
      state: "failed",
      error: "teams_group_audience_changed",
    });
    return;
  }
  try {
    const id = await deliver(
      {
        serviceUrl: r.service_url,
        conversationId: r.conversation_id,
        threadId: r.thread_id,
        botId: r.bot_id,
      },
      Number(output.source_sequence) === -1
        ? admissionNotice(
            deps,
            r,
            output.payload.notice === "audience_changed" ? "audience_changed" : "admission",
          )
        : output.payload.text,
    );
    await settleTeamsOutput(deps.db, i, output.operation_id, {
      state: "delivered",
      providerMessageId: id,
    });
  } catch (error) {
    const response = (error as { response?: { status?: number; headers?: Record<string, string> } })
      ?.response;
    if (response?.status === 429) {
      const seconds = Number(response.headers?.["retry-after"]);
      await settleTeamsOutput(deps.db, i, output.operation_id, {
        state: "pending",
        error: "teams_throttled",
        retryMs: Number.isFinite(seconds)
          ? Math.max(1000, Math.min(seconds * 1000, 3_600_000))
          : 60_000,
      });
    } else
      await settleTeamsOutput(deps.db, i, output.operation_id, {
        state:
          response?.status && response.status >= 400 && response.status < 500
            ? "failed"
            : "unknown",
        error: "teams_delivery_failed",
      });
  }
}
export async function drainTeamsBotOnce(
  deps: ApiRouteDeps,
  deliver: TeamsSender = async (m, text) => send(await runtime(deps), m, text),
  readRoster: TeamsRosterReader = async (m) => readGroupRoster(deps, m),
): Promise<void> {
  if (
    !teamsBotConfigured(deps.settings) ||
    (!deps.settings.teamsBotEnabled && !deps.settings.teamsBotAllowedTenantIds.length)
  )
    return;
  const installations = await listTeamsInstallations(deps.db, inventoryCursors.get(deps) ?? null);
  if (installations.length === 100) inventoryCursors.set(deps, installations.at(-1)!.tenant_id);
  else inventoryCursors.delete(deps);
  for (const i of installations) {
    if (!teamsTenantEnabled(deps.settings, i.tenant_id)) continue;
    const route = await claimTeamsRoute(deps.db, i);
    if (!route) continue;
    const renewal = setInterval(() => {
      void renewTeamsRoute(deps.db, i, route).catch(() => false);
    }, 30_000);
    try {
      await drainRoute(deps, i, route, deliver, readRoster);
    } finally {
      clearInterval(renewal);
      await releaseTeamsRoute(deps.db, i, route);
    }
  }
}
export function startTeamsBotPump(deps: ApiRouteDeps): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await drainTeamsBotOnce(deps);
    } catch (error) {
      deps.observability?.error("Teams conversation processing failed", {
        origin: "api",
        errorClass: error instanceof Error ? error.name : "TeamsPumpError",
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 2000);
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
