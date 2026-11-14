import type { App } from "@microsoft/teams.apps";
import type { Hono, Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Settings } from "@opengeni/config";
import type { AccessGrant } from "@opengeni/contracts";
import { turnCompletedReply } from "@opengeni/contracts";
import { withoutProviderTrackingInText } from "@opengeni/contracts/citation-urls";
import { rewriteClaudeCiteTags } from "@opengeni/contracts/claude-cite-tags";
import {
  managedHumanSubjectForRequest,
  requireAccessContext,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  hasPermission,
  createSessionForRequest,
  acceptSessionUserMessage,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
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
  claimTeamsReply,
  claimTeamsWelcome,
  pruneTeamsReplyClaims,
  pruneTeamsRoutePrompts,
  releaseTeamsReply,
  type TeamsReplyClaim,
  releaseTeamsWelcome,
  pruneTeamsWelcomes,
  invalidateTeamsGroup,
  clearTeamsContextConversation,
  teamsGroupRouteActive,
  type TeamsGroupAudience,
  getWorkspaceTeamsInstallation,
  getTeamsAgentInWorkspace,
  getTeamsTurnRouting,
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
  markTeamsTurnAnswered,
  enqueueTeamsOutput,
  claimTeamsOutput,
  settleTeamsOutput,
  listSessionEventPage,
  renewTeamsRoute,
  teamsDeliveryStatus,
  refuseTeamsRouteOutputs,
  teamsReplyPending,
  getTeamsDeliveredReply,
  createFeedback,
  FeedbackConflictError,
  FeedbackTargetNotFoundError,
  SessionAgentNotFoundError,
  namedSubjectIsActiveOrganizationMember,
  resolveSlackTargetAuthority,
  getTeamsChatChoice,
  setTeamsChatChoice,
  clearTeamsChatChoice,
  putTeamsRoutePrompt,
  takeTeamsRoutePromptOption,
  teamsAgentLabel,
  teamsWorkspaceName,
  type TeamsChatTarget,
  type TeamsInstallation,
  type TeamsRoute,
} from "@opengeni/db";
import { parseRequestJson } from "../http/request-body";
import { disconnectAuditActor } from "../http/disconnect-audit-actor";
import {
  teamsConnectionRefused,
  teamsLinkConflict,
  teamsLinkIdentityMismatch,
} from "./teams-setup-refusals";
import {
  teamsBotConfigured,
  teamsTenantEnabled,
  teamsServiceUrl,
  normalizeTeamsMessage,
  teamsThreadlessConversationId,
  normalizeTeamsFeedback,
  teamsPersonalInstall,
  teamsUnreadablePersonalMessage,
  teamsRouteId,
  mintTeamsProof,
  verifyTeamsProof,
  type TeamsFeedback,
  type TeamsMessage,
  type TeamsLinkProof,
  type TeamsMessageRejection,
  type TeamsPersonalInstall,
} from "./teams-protocol";
import {
  loadTeamsMentionModelContext,
  markTeamsContextMention,
  recordTeamsContext,
  reviseTeamsContext,
} from "./teams-context";
import {
  mintTeamsAdminState,
  teamsAdminAuthorizationUrl,
  teamsSelfServeTenantAllowed,
  verifyTeamsAdminSignIn,
  verifyTeamsAdminState,
  TEAMS_ADMIN_ROLE_IDS,
  TeamsAdminProofError,
  type TeamsAdminIdentity,
  type TeamsAdminSignInConfig,
} from "./teams-admin-proof";
import {
  createTeamsOnboardingBudgets,
  type TeamsOnboardingBudgets,
  type TeamsOnboardingReservation,
} from "./teams-onboarding-limit";
import {
  TEAMS_CANNOT_START_TEXT,
  TEAMS_SHARED_CANNOT_START_TEXT,
  TEAMS_UNREADABLE_MESSAGE_TEXT,
  TEAMS_CONNECT_REMINDER_TEXT,
  TEAMS_DEFAULT_APP_NAME,
  TEAMS_SHARED_CONNECT_TEXT,
  TEAMS_WORK_ACCOUNT_TEXT,
  teamsAiGeneratedEntity,
  teamsCommand,
  teamsConnectText,
  teamsAppOffInConversationText,
  teamsEventUuid,
  teamsHelp,
  teamsMarkdown,
  teamsMarkdownParts,
  teamsNoticeCard,
  teamsPlainPreview,
  teamsAccountReply,
  teamsNotLinkedReply,
  teamsWelcome,
  type TeamsCommand,
  type TeamsExperienceReply,
  type TeamsExperienceState,
  type TeamsNoticeLink,
} from "./teams-experience";

import {
  resolveTeamsGroupAudience,
  sameTeamsAudience,
  teamsGroupMembershipChange,
} from "./teams-group";
import {
  loadTeamsRouteDirectory,
  resolveTeamsRoute,
  teamsChoiceUnavailableText,
  teamsReplyHeader,
  teamsRouteOptionNamed,
  teamsRouteOptions,
  teamsRouteTargetOffered,
  teamsSwitchCardText,
  teamsSwitchCommand,
  teamsSwitchedText,
  teamsWorkspaceInReach,
  TEAMS_NO_WORKSPACE_TEXT,
  type TeamsRouteDirectory,
} from "./teams-routing";
import { organizationAgentAskerPerson } from "./organization-agents";
import {
  isTeamsOrganizationAgentRoute,
  teamsFullTenantMember,
  teamsOrganizationAgentGrant,
  teamsOrganizationAgentInstructions,
  teamsOrganizationAgentMembersOnlyText,
  teamsOrganizationAgentNotEligibleText,
  teamsOrganizationAgentNoticeText,
  teamsOrganizationAgentUnavailableText,
  teamsOrganizationAgentRouteId,
  teamsOrganizationAgentSessionOptions,
  type TeamsMemberFacts,
} from "./teams-organization-agents";

const ENDPOINT = "/v1/integrations/teams/messages";
const ROOT = "/v1/workspaces/:workspaceId/integrations/teams";
const inventoryCursors = new WeakMap<ApiRouteDeps, string>();
const runtimes = new WeakMap<ApiRouteDeps, Promise<App>>();
const onboardingBudgetsByDeps = new WeakMap<ApiRouteDeps, TeamsOnboardingBudgets>();
const typingLoops = new WeakMap<ApiRouteDeps, Map<string, TeamsTypingLoop>>();

function configuredBase(deps: ApiRouteDeps): string {
  const base = deps.settings.webBaseUrl ?? deps.settings.publicBaseUrl;
  if (!base) throw new Error("teams_public_url_missing");
  return base;
}
type TeamsPersonalContact = Pick<
  TeamsMessage,
  "tenantId" | "actorId" | "actorName" | "conversationId" | "serviceUrl" | "personal"
>;
function proofLink(
  deps: ApiRouteDeps,
  m: TeamsPersonalContact,
  i: TeamsInstallation | null,
): string {
  const purpose = i ? "link" : "setup";
  const token = mintTeamsProof(deps.settings.integrationsStateSecret!, {
    purpose,
    tenantId: m.tenantId,
    actorId: m.actorId,
    workspaceId: i?.workspace_id ?? null,
    generation: i?.generation ?? null,
    // A refused account link names whose link it is.
    ...(i && m.actorName ? { actorName: m.actorName } : {}),
    // Setup confirms in the chat that asked for it once the organization is connected.
    ...(i ? {} : { conversation: { id: m.conversationId, serviceUrl: m.serviceUrl } }),
  });
  // With workspace routing, a link is an organization matter: any member of
  // the organization links on the Teams page, workspace access or not.
  const routed = Boolean(i) && deps.settings.teamsWorkspaceRoutingEnabled;
  const url = new URL(
    i && !routed ? `/workspaces/${i.workspace_id}/plugins` : "/teams/connect",
    configuredBase(deps),
  );
  url.hash = new URLSearchParams(
    i
      ? { teams_link: token, ...(routed ? { teams_workspace: i.workspace_id } : {}) }
      : { teams_setup: token },
  ).toString();
  return url.toString();
}
function sessionUrl(deps: ApiRouteDeps, r: TeamsRoute): string {
  return new URL(
    `/workspaces/${routeSessionWorkspace(r)}/sessions/${r.session_id}`,
    configuredBase(deps),
  ).toString();
}
/** The workspace a route's session lives in. */
/** What deciding who a route's work runs as reads from the route. */
type TeamsRoutePrincipal = Pick<
  TeamsRoute,
  "route_id" | "workspace_id" | "subject_id" | "personal" | "session_workspace_id" | "agent_id"
>;
function routeSessionWorkspace(
  r: Pick<TeamsRoute, "session_workspace_id" | "workspace_id">,
): string {
  return r.session_workspace_id ?? r.workspace_id;
}
type TeamsTarget = Pick<TeamsMessage, "serviceUrl" | "conversationId" | "threadId" | "botId">;
function deliveryConversation(m: TeamsTarget): string {
  return m.threadId && !m.conversationId.includes(";messageid=")
    ? `${m.conversationId};messageid=${m.threadId}`
    : m.conversationId;
}
/**
 * The id of a message Teams accepted, or null when it accepted it without one.
 * Teams may answer a send, notably one carrying a card, with an empty 202
 * ("accepted for processing"): the message is still delivered, so a missing id
 * is never a failure to retry.
 */
function teamsReceipt(response: unknown): string | null {
  const id = (response as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id ? id : null;
}
/**
 * A notice from Opengeni with a link, as a message whose card shows the text
 * and a button that opens the link. A card has no message text, so the
 * message carries a plain-text `summary` and the card its `fallbackText`, for
 * channels and clients that can't show cards.
 */
export function teamsNoticeActivity(text: string, link: TeamsNoticeLink, threadId: string | null) {
  // The SDK's input type omits the Bot Framework `summary` field.
  const summary: { summary?: string } = { summary: teamsPlainPreview(text) };
  return {
    type: "message" as const,
    ...summary,
    ...(threadId ? { replyToId: threadId } : {}),
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: teamsNoticeCard(text, link),
      },
    ],
  };
}
/**
 * Text is Teams Markdown. An agent reply carries Teams' AI label and feedback
 * buttons. A notice with a link goes out as a card whose button opens it.
 */
async function send(
  app: App,
  m: TeamsTarget,
  text: string,
  options: { ai?: boolean; link?: TeamsNoticeLink } = {},
): Promise<string | null> {
  const client = app.api.fromServiceUrl({ serviceUrl: teamsServiceUrl(m.serviceUrl) });
  const response = await client.conversations.createActivity(
    deliveryConversation(m),
    options.link
      ? teamsNoticeActivity(text, options.link, m.threadId)
      : {
          type: "message",
          text,
          textFormat: "markdown",
          ...(m.threadId ? { replyToId: m.threadId } : {}),
          ...(options.ai
            ? {
                entities: [teamsAiGeneratedEntity()],
                channelData: { feedbackLoop: { type: "default" } },
              }
            : {}),
        },
  );
  return teamsReceipt(response);
}
/** Shows that Opengeni is working on a reply. Teams clears it when the next message arrives. */
async function sendTyping(app: App, m: TeamsTarget): Promise<void> {
  await app.api
    .fromServiceUrl({ serviceUrl: teamsServiceUrl(m.serviceUrl) })
    .conversations.createActivity(deliveryConversation(m), {
      type: "typing",
      ...(m.threadId ? { replyToId: m.threadId } : {}),
    });
}
/**
 * A deterministic reply: Markdown text and, when it has one, a card button.
 * A link button carries an identity proof, so it is only ever sent in a
 * personal chat; elsewhere the reply goes out as text alone.
 */
export async function sendTeamsReply(
  app: App,
  m: TeamsTarget & { personal: boolean },
  reply: TeamsExperienceReply,
  linkUrl?: () => string,
): Promise<string | null> {
  const action =
    reply.action?.kind === "link"
      ? m.personal && linkUrl
        ? { type: "Action.OpenUrl", title: reply.action.title, url: linkUrl() }
        : null
      : reply.action?.kind === "command"
        ? {
            type: "Action.Submit",
            title: reply.action.title,
            data: { msteams: { type: "imBack", value: reply.action.command } },
          }
        : null;
  // A switch card: one button per row, each sending its command back as the
  // person's own message. The numbered text works without the buttons too.
  const choices = (reply.choices ?? []).slice(0, TEAMS_CARD_CHOICES).map((choice) => ({
    type: "ActionSet",
    actions: [
      {
        type: "Action.Submit",
        title: choice.title.slice(0, 80),
        data: { msteams: { type: "imBack", value: choice.command } },
      },
    ],
  }));
  const client = app.api.fromServiceUrl({ serviceUrl: teamsServiceUrl(m.serviceUrl) });
  const response = await client.conversations.createActivity(deliveryConversation(m), {
    type: "message",
    text: reply.text,
    textFormat: "markdown",
    ...(m.threadId ? { replyToId: m.threadId } : {}),
    ...(action || choices.length
      ? {
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: {
                $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                type: "AdaptiveCard",
                version: "1.2",
                ...(choices.length ? { body: choices } : {}),
                ...(action ? { actions: [action] } : {}),
              },
            },
          ],
        }
      : {}),
  });
  return teamsReceipt(response);
}
/** The most buttons one switch card shows; every row is still numbered in its text. */
const TEAMS_CARD_CHOICES = 25;
const ONBOARDING_TEXT = {
  setup: () => "Connect Teams to Opengeni.",
  link: () => "Link your Opengeni account to use this bot.",
  connect: (appName: string) => `Welcome to ${appName}. ${teamsConnectText(appName)}`,
} as const;
const ONBOARDING_ACTION = {
  setup: "Connect Teams",
  link: "Link account",
  connect: "Connect your organization",
} as const;
/** The notice for a tenant that isn't admitted, with the operator's support address when set. */
export function teamsTenantUnavailableText(
  settings: Pick<Settings, "supportEmail"> & Partial<Pick<Settings, "teamsAppName">>,
): string {
  const appName = settings.teamsAppName ?? TEAMS_DEFAULT_APP_NAME;
  return settings.supportEmail
    ? `${appName} isn't available for your organization yet. Your Microsoft 365 or Teams admin can request access at ${settings.supportEmail}.`
    : `${appName} isn't available for your organization yet. Your Microsoft 365 or Teams admin can contact the Opengeni team to request access.`;
}
export const TEAMS_SETUP_CONFIRMED_TEXT =
  "Opengeni is now connected for your organization. Send me a message to start. Everyone else in your organization links their own Opengeni account the first time they message me.";

/** Identity proofs stay in a personal chat and only in the button destination. */
export async function sendTeamsOnboarding(
  app: App,
  m: Pick<TeamsMessage, "personal" | "serviceUrl" | "conversationId">,
  purpose: "setup" | "link" | "connect",
  url: string,
  appName: string = TEAMS_DEFAULT_APP_NAME,
): Promise<string | null> {
  if (!m.personal) throw new Error("teams_onboarding_requires_personal_chat");
  const text = ONBOARDING_TEXT[purpose](appName);
  const client = app.api.fromServiceUrl({ serviceUrl: teamsServiceUrl(m.serviceUrl) });
  const response = await client.conversations.createActivity(m.conversationId, {
    type: "message",
    text,
    textFormat: "plain",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          actions: [
            {
              type: "Action.OpenUrl",
              title: ONBOARDING_ACTION[purpose],
              url,
            },
          ],
        },
      },
    ],
  });
  return teamsReceipt(response);
}
export type TeamsUnconnectedOutcome =
  | "tenant_disabled"
  | "tenant_unavailable_notice_sent"
  | "setup_link_sent"
  | "connect_link_sent"
  | "connect_reminder_sent"
  | "work_account_notice_sent"
  | "shared_connect_reminder_sent"
  | "onboarding_reply_limited"
  | "setup_not_permitted";

function onboardingBudgets(deps: ApiRouteDeps): TeamsOnboardingBudgets {
  let budgets = onboardingBudgetsByDeps.get(deps);
  if (!budgets) {
    budgets = createTeamsOnboardingBudgets(deps.db, (error) =>
      deps.observability?.warn("Teams onboarding limits fell back to memory", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    onboardingBudgetsByDeps.set(deps, budgets);
  }
  return budgets;
}

/** An admitted Microsoft work or school tenant may be connected by its own administrator. */
export function teamsSelfServeSetupAvailable(settings: Settings, tenantId: string): boolean {
  return (
    settings.teamsBotSelfServeSetupEnabled &&
    teamsTenantEnabled(settings, tenantId) &&
    teamsSelfServeTenantAllowed(tenantId)
  );
}
/**
 * Whether this tenant is a personal Microsoft account's, which can never
 * connect Opengeni, on a deployment where organizations connect themselves.
 */
function teamsWorkAccountRequired(settings: Settings, tenantId: string): boolean {
  return (
    settings.teamsBotSelfServeSetupEnabled &&
    teamsTenantEnabled(settings, tenantId) &&
    !teamsSelfServeTenantAllowed(tenantId)
  );
}

/**
 * The way forward for a person whose Teams organization has no active
 * connection: an operator-approved installer gets the setup link, everyone
 * else gets a welcome with the self-serve Connect your organization link (or a
 * not-available notice when the tenant isn't admitted, or a work or school
 * account notice for a personal Microsoft account). Once a person's or
 * tenant's cards are used up, a short reminder that points to help (which
 * always answers with the way forward) is sent instead of silence, from its
 * own larger budget. In a group chat or channel, a mention gets a reminder to
 * message the bot directly. Replies are bounded per person, per tenant and
 * across the deployment, so a tenant can't make the bot answer every message
 * forever. Installing the app (`source` "install") gets at most a welcome,
 * from its own smaller budget, and never a not-available notice. The operator
 * setup link, which skips the Microsoft sign-in, only answers a person's own
 * authenticated 1:1 message: an install event's sender needn't be the person
 * whose chat it is.
 */
export async function replyToUnconnectedTeamsTenant(
  deps: ApiRouteDeps,
  app: App,
  m: TeamsPersonalContact & Pick<TeamsMessage, "botId"> & { threadId?: string | null },
  source: "message" | "install" = "message",
  budgets: TeamsOnboardingBudgets = onboardingBudgets(deps),
): Promise<TeamsUnconnectedOutcome> {
  const admitted = teamsTenantEnabled(deps.settings, m.tenantId);
  if (!m.personal) {
    if (!admitted) return "tenant_disabled";
    const reminder =
      source === "message" && deps.settings.teamsBotSelfServeSetupEnabled
        ? await budgets.sharedNotice.reserve(m.tenantId, m.actorId)
        : null;
    if (!reminder) return "setup_not_permitted";
    await sendReserved(reminder, () =>
      send(app, { ...m, threadId: m.threadId ?? null }, TEAMS_SHARED_CONNECT_TEXT),
    );
    return "shared_connect_reminder_sent";
  }
  if (!admitted) {
    const notice =
      source === "message" &&
      deps.settings.teamsBotSelfServeSetupEnabled &&
      teamsBotConfigured(deps.settings)
        ? await budgets.unavailableNotice.reserve(m.tenantId, m.actorId)
        : null;
    if (!notice) return "tenant_disabled";
    await sendReserved(notice, () =>
      send(app, { ...m, threadId: null }, teamsTenantUnavailableText(deps.settings)),
    );
    return "tenant_unavailable_notice_sent";
  }
  if (
    source === "message" &&
    deps.settings.teamsBotSetupAdminIds.includes(`${m.tenantId}:${m.actorId}`)
  ) {
    await sendTeamsOnboarding(
      app,
      m,
      "setup",
      proofLink(deps, m, null),
      deps.settings.teamsAppName,
    );
    return "setup_link_sent";
  }
  const personal = { ...m, threadId: null };
  const budget = source === "install" ? budgets.installWelcome : budgets.connect;
  if (teamsWorkAccountRequired(deps.settings, m.tenantId)) {
    // Short text either way, so a used-up budget falls back to the reminders'.
    const granted =
      (await budget.reserve(m.tenantId, m.actorId)) ??
      (await budgets.reminder.reserve(m.tenantId, m.actorId));
    if (!granted) return "onboarding_reply_limited";
    await sendReserved(granted, () => send(app, personal, TEAMS_WORK_ACCOUNT_TEXT));
    return "work_account_notice_sent";
  }
  if (!teamsSelfServeSetupAvailable(deps.settings, m.tenantId)) return "setup_not_permitted";
  const card = await budget.reserve(m.tenantId, m.actorId);
  if (card) {
    await sendReserved(card, () =>
      sendTeamsOnboarding(app, m, "connect", proofLink(deps, m, null), deps.settings.teamsAppName),
    );
    return "connect_link_sent";
  }
  const reminder = await budgets.reminder.reserve(m.tenantId, m.actorId);
  if (!reminder) return "onboarding_reply_limited";
  await sendReserved(reminder, () =>
    send(
      app,
      personal,
      source === "install"
        ? `Welcome to ${deps.settings.teamsAppName}. ${TEAMS_CONNECT_REMINDER_TEXT}`
        : TEAMS_CONNECT_REMINDER_TEXT,
    ),
  );
  return "connect_reminder_sent";
}
/**
 * Sends a reserved reply, giving the reservation back when Teams clearly
 * refused it, so a redelivery can still answer. A throttled reply keeps its
 * count: Teams throttles per conversation, so a person flooding their own chat
 * could otherwise retry without limit and use up the shared budgets. Their own
 * caps bound those retries, and a redelivery falls back to the short reminder.
 */
async function sendReserved(
  reservation: TeamsOnboardingReservation,
  reply: () => Promise<unknown>,
): Promise<void> {
  try {
    await reply();
  } catch (error) {
    const failure = teamsSendFailure(error);
    // A duplicate delivery sent nothing; the first delivery keeps its own count.
    if (error instanceof TeamsDuplicateReply || (failure.refused && !failure.throttled))
      await reservation.release().catch(() => {
        // The reservation then lapses with its window.
      });
    throw error;
  }
}

/** Tells the installer's 1:1 chat that setup finished. */
export async function confirmTeamsSetup(
  app: App,
  conversation: NonNullable<TeamsLinkProof["conversation"]>,
): Promise<string | null> {
  return await send(
    app,
    {
      serviceUrl: conversation.serviceUrl,
      conversationId: conversation.id,
      threadId: null,
      botId: "",
    },
    TEAMS_SETUP_CONFIRMED_TEXT,
  );
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
  r: TeamsRoutePrincipal,
  identity: AccessGrant,
): Promise<AccessGrant | null> {
  if (!r.session_workspace_id) return identity;
  if (!r.personal || identity.subjectId !== r.subject_id) return null;
  return await ownPersonalWorkspaceGrant(deps, i, identity.subjectId, r.session_workspace_id);
}
/**
 * With workspace routing, who a linked Teams person is: their link, while
 * they are an active full member of the installation's organization (read
 * live). The link is an organization fact, like a Slack link by organization
 * membership; what they can do is decided per workspace by
 * `teamsTargetGrant`. Without routing it is the installation workspace's
 * grant, as before.
 */
async function teamsIdentity(
  deps: ApiRouteDeps,
  i: TeamsInstallation,
  actorId: string,
): Promise<{ subjectId: string } | null> {
  if (!deps.settings.teamsWorkspaceRoutingEnabled) return await actorGrant(deps, i, actorId);
  const subjectId = await getTeamsActor(deps.db, i, actorId);
  if (!subjectId) return null;
  return (await namedSubjectIsActiveOrganizationMember(deps.db, {
    accountId: i.account_id,
    subjectId,
  }))
    ? { subjectId }
    : null;
}
/**
 * The person's live authority in one workspace of the installation's
 * organization: their membership there, or their own Personal workspace,
 * either one only while they still hold it (Slack's target authority), and
 * only while the organization's Teams reach includes that workspace.
 */
async function teamsTargetGrant(
  db: ApiRouteDeps["db"],
  i: TeamsInstallation,
  subjectId: string,
  workspaceId: string,
): Promise<AccessGrant | null> {
  const grant = await resolveSlackTargetAuthority(db, {
    subjectId,
    targetAccountId: i.account_id,
    targetWorkspaceId: workspaceId,
  });
  return grant &&
    grant.accountId === i.account_id &&
    grant.workspaceId === workspaceId &&
    (await teamsWorkspaceInReach(db, i, subjectId, workspaceId))
    ? grant
    : null;
}
/**
 * The grant a route's work runs with for `actorId`, read live. A 1:1 route
 * with workspace routing uses the linked person's authority in the route's
 * own workspace; everything else keeps the installation's rules.
 */
async function routeActorGrant(
  deps: ApiRouteDeps,
  i: TeamsInstallation,
  r: TeamsRoutePrincipal,
  actorId: string,
): Promise<AccessGrant | null> {
  if (deps.settings.teamsWorkspaceRoutingEnabled && r.personal) {
    const identity = await teamsIdentity(deps, i, actorId);
    if (!identity || identity.subjectId !== r.subject_id) return null;
    return await teamsTargetGrant(deps.db, i, identity.subjectId, routeSessionWorkspace(r));
  }
  const identity = await actorGrant(deps, i, actorId);
  return identity && (await routeSessionGrant(deps, i, r, identity));
}
/**
 * Who a route's work runs as for `actorId`, read live, and the linked person
 * behind it. Usually that person's own grant (`routeActorGrant`). A route
 * made for an organization agent's open use runs as the agent's service
 * principal instead, only while the person is still linked and an active
 * full member of the organization, the agent is still open to the
 * organization in the route's workspace, and the reach still includes it.
 */
async function routeActor(
  deps: ApiRouteDeps,
  i: TeamsInstallation,
  r: TeamsRoutePrincipal,
  actorId: string,
): Promise<{ grant: AccessGrant; subjectId: string } | null> {
  if (isTeamsOrganizationAgentRoute(r)) {
    if (!deps.settings.teamsWorkspaceRoutingEnabled || !r.personal || !r.agent_id) return null;
    const identity = await teamsIdentity(deps, i, actorId);
    if (!identity || identity.subjectId !== r.subject_id) return null;
    const workspaceId = routeSessionWorkspace(r);
    const agent = await getTeamsAgentInWorkspace(deps.db, {
      accountId: i.account_id,
      workspaceId,
      agentId: r.agent_id,
    });
    if (
      !agent?.organizationAccess ||
      agent.accountId !== i.account_id ||
      !(await teamsWorkspaceInReach(deps.db, i, identity.subjectId, workspaceId))
    )
      return null;
    return {
      grant: teamsOrganizationAgentGrant(agent, {
        tenantId: i.tenant_id,
        actorId,
        opengeniSubjectId: identity.subjectId,
      }),
      subjectId: identity.subjectId,
    };
  }
  const grant = await routeActorGrant(deps, i, r, actorId);
  return grant ? { grant, subjectId: grant.subjectId } : null;
}
/** Whether a route's session still has the audience the route was made for. */
function routeAudienceHolds(
  r: TeamsRoute,
  audience: { visibility: string; ownerSubjectId: string | null } | null,
): boolean {
  if (!audience) return false;
  // An organization agent's chat is visible to its workspace's members.
  if (isTeamsOrganizationAgentRoute(r))
    return r.personal && audience.visibility === "workspace_shared";
  if (!r.personal) return audience.visibility !== "user_private";
  return audience.visibility === "user_private" && audience.ownerSubjectId === r.subject_id;
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
function experienceState(
  personal: boolean,
  i: TeamsInstallation | null,
  grant: { subjectId: string } | null,
  sharedConversations = false,
  unconnected?: { deps: ApiRouteDeps; tenantId: string },
): TeamsExperienceState {
  const setup =
    i?.active || !unconnected
      ? undefined
      : teamsSelfServeSetupAvailable(unconnected.deps.settings, unconnected.tenantId)
        ? ("connect" as const)
        : teamsWorkAccountRequired(unconnected.deps.settings, unconnected.tenantId)
          ? ("work_account" as const)
          : undefined;
  // Only an organization that isn't connected needs somewhere else to turn.
  const supportEmail = i?.active ? undefined : unconnected?.deps.settings.supportEmail;
  return {
    personal,
    installation: i?.active ? "active" : "unavailable",
    linked: Boolean(grant),
    sharedConversations,
    ...(setup ? { setup } : {}),
    ...(supportEmail ? { supportEmail } : {}),
    ...(unconnected ? { appName: unconnected.deps.settings.teamsAppName } : {}),
  };
}
/**
 * With workspace routing, where a linked person's 1:1 chat goes now, for the
 * welcome and help. Nothing without it.
 */
async function teamsRoutingState(
  deps: ApiRouteDeps,
  i: TeamsInstallation,
  who: { actorId: string; subjectId: string },
): Promise<Pick<TeamsExperienceState, "routing">> {
  if (!deps.settings.teamsWorkspaceRoutingEnabled) return {};
  const [directory, choice] = await Promise.all([
    loadTeamsRouteDirectory(deps.db, i, who.subjectId),
    getTeamsChatChoice(deps.db, i, who),
  ]);
  const now = resolveTeamsRoute({
    text: "",
    appName: deps.settings.teamsAppName,
    directory,
    choice,
  });
  return {
    routing:
      now.kind === "resolved"
        ? { workspaceLabel: now.workspaceLabel, agentName: now.agentName }
        : { workspaceLabel: null, agentName: null },
  };
}
/** Whether any group chat or channel of this tenant is on the allowlists. */
function teamsSharedConversationsEnabled(deps: ApiRouteDeps, tenantId: string): boolean {
  const prefix = `${tenantId}:`;
  return [
    ...deps.settings.teamsBotAllowedGroupChatIds,
    ...deps.settings.teamsBotAllowedChannelIds,
  ].some((id) => id.startsWith(prefix));
}
/**
 * The welcome for someone who just added the bot for themselves. In an
 * organization that hasn't connected Opengeni, the installer instead gets the
 * way to connect it when they may (see replyToUnconnectedTeamsTenant).
 *
 * Teams may deliver one install several times, to any API replica, so the
 * chat's welcome is claimed in the database first and sent at most once per
 * claim window. The install never fails once a welcome may have arrived:
 * Teams is asked to redeliver it (503) only when nothing reached the person
 * and a retry can help, and then the claim is given back first. When the send
 * may have arrived (a timeout, a reset, a Teams 5xx), the claim is kept, so a
 * replica that stops between claiming and sending leaves that install without
 * a welcome rather than risk a second one.
 */
async function welcomeTeamsInstall(
  deps: ApiRouteDeps,
  app: App,
  install: TeamsPersonalInstall,
): Promise<{ outcome: string; status: number }> {
  const claim = await claimTeamsWelcome(deps.db, install);
  if (!claim) return { outcome: "welcome_duplicate", status: 200 };
  const attempt = { sending: false, connected: true };
  let result: { outcome: string; delivered: boolean };
  try {
    result = await sendTeamsInstallWelcome(deps, app, install, attempt);
  } catch (error) {
    const failure = attempt.sending
      ? teamsSendFailure(error)
      : { refused: true, retry: true, throttled: false };
    const outcome = attempt.connected ? "welcome_failed" : "onboarding_reply_failed";
    if (!failure.refused) return { outcome, status: 200 };
    // A redelivery can only send once the claim is back; otherwise the claim
    // lapses at the end of its window.
    const released = await releaseTeamsWelcome(deps.db, claim).then(
      () => true,
      () => false,
    );
    return { outcome, status: failure.retry && released ? 503 : 200 };
  }
  if (result.delivered)
    await pruneTeamsWelcomes(deps.db).catch(() => {
      // Pruning is housekeeping; the next welcome tries again.
    });
  else
    await releaseTeamsWelcome(deps.db, claim).catch(() => {
      // The claim then lapses at the end of its window.
    });
  return { outcome: result.outcome, status: 200 };
}
/**
 * Whether a failed Teams send clearly didn't reach the person (`refused`),
 * whether Teams redelivering the activity could help (`retry`), and whether
 * Teams throttled it (`throttled`). A send that may have arrived, such as a
 * timeout, a reset connection or a Teams 5xx, is none of these.
 */
function teamsSendFailure(error: unknown): {
  refused: boolean;
  retry: boolean;
  throttled: boolean;
} {
  const e = error as { response?: { status?: unknown }; code?: unknown } | null | undefined;
  const httpStatus = e?.response?.status;
  if (typeof httpStatus === "number")
    return {
      refused: httpStatus >= 400 && httpStatus < 500,
      retry: httpStatus === 429,
      throttled: httpStatus === 429,
    };
  const code = e?.code;
  // Thrown before any request, such as a rejected service URL.
  if (typeof code !== "string") return { refused: true, retry: false, throttled: false };
  const unsent = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code);
  return { refused: unsent, retry: unsent, throttled: false };
}
const DUPLICATE_REPLY = Symbol("duplicate_reply");
/** Thrown instead of sending when another delivery of the activity already replied. */
class TeamsDuplicateReply extends Error {
  constructor() {
    super("teams_reply_duplicate");
  }
}
type TeamsReplies = {
  /** Sends through this client claim the activity first. */
  app: App;
  /** Runs a reply, returning DUPLICATE_REPLY when another delivery already replied. */
  once<T>(reply: () => Promise<T>): Promise<T | typeof DUPLICATE_REPLY>;
  /** Whether a send was skipped because another delivery already replied. */
  duplicate(): boolean;
};
/**
 * Replies the bot sends itself for one activity (help, link, unlink, the
 * onboarding, reminder and notice replies) don't go through the inbox, and
 * Teams redelivers an activity after a slow or failed response, to any
 * replica. The first send for an activity claims it in the database, so a
 * redelivery isn't answered twice; later sends for the same delivery reuse the
 * claim. The claim is taken only when a reply is about to go out, so activities
 * that get no reply write nothing. When nothing of the delivery reached the
 * person and Teams clearly refused the send, the claim is given back so a
 * redelivery can answer. If the claim can't be made, the reply goes out
 * anyway: a rare repeat is better than silence. Only
 * `api.fromServiceUrl(...).conversations.createActivity`, the send path of
 * every reply helper here, is claimed; a helper that sends another way must
 * be covered here too.
 */
function teamsReplies(
  deps: ApiRouteDeps,
  app: App,
  activity: { tenantId: string; conversationId: string; activityId: string },
): TeamsReplies {
  let claimed: Promise<TeamsReplyClaim | "unclaimed" | null> | undefined;
  let sent = false;
  let duplicate = false;
  const claim = () =>
    (claimed ??= claimTeamsReply(deps.db, activity).then(
      (held) => {
        if (held)
          void pruneTeamsReplyClaims(deps.db).catch(() => {
            // Pruning is housekeeping; the next reply tries again.
          });
        return held;
      },
      () => "unclaimed" as const,
    ));
  const createActivity =
    (conversations: { createActivity: (...args: never[]) => Promise<unknown> }) =>
    async (...args: never[]) => {
      const held = await claim();
      if (held === null) {
        duplicate = true;
        throw new TeamsDuplicateReply();
      }
      try {
        const response = await conversations.createActivity(...args);
        sent = true;
        return response;
      } catch (error) {
        if (!sent && held !== "unclaimed" && teamsSendFailure(error).refused) {
          claimed = undefined;
          await releaseTeamsReply(deps.db, held).catch(() => {
            // The claim then lapses at the end of its window.
          });
        }
        throw error;
      }
    };
  const bound = <T extends object>(target: T, prop: string | symbol) => {
    const value = Reflect.get(target, prop) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  };
  const fromServiceUrl = (...args: Parameters<App["api"]["fromServiceUrl"]>) => {
    const client = app.api.fromServiceUrl(...args);
    return new Proxy(client, {
      get: (target, prop) =>
        prop === "conversations"
          ? new Proxy(target.conversations, {
              get: (conversations, name) =>
                name === "createActivity"
                  ? createActivity(conversations as never)
                  : bound(conversations, name),
            })
          : bound(target, prop),
    });
  };
  const api = new Proxy(app.api, {
    get: (target, prop) => (prop === "fromServiceUrl" ? fromServiceUrl : bound(target, prop)),
  });
  return {
    app: new Proxy(app, {
      get: (target, prop) => (prop === "api" ? api : bound(target, prop)),
    }),
    once: async (reply) => {
      try {
        return await reply();
      } catch (error) {
        if (error instanceof TeamsDuplicateReply || duplicate) return DUPLICATE_REPLY;
        throw error;
      }
    },
    duplicate: () => duplicate,
  };
}
/** What an organization that hasn't connected may have been sent. */
const UNCONNECTED_DELIVERED: ReadonlySet<TeamsUnconnectedOutcome> = new Set([
  "tenant_unavailable_notice_sent",
  "setup_link_sent",
  "connect_link_sent",
  "connect_reminder_sent",
  "work_account_notice_sent",
]);
async function sendTeamsInstallWelcome(
  deps: ApiRouteDeps,
  app: App,
  install: TeamsPersonalInstall,
  attempt: { sending: boolean; connected: boolean },
): Promise<{ outcome: string; delivered: boolean }> {
  const i = await getTeamsInstallation(deps.db, install.tenantId);
  const active = i?.active ? i : null;
  if (!active && install.actorId) {
    attempt.connected = false;
    attempt.sending = true;
    const outcome = await replyToUnconnectedTeamsTenant(
      deps,
      app,
      { ...install, actorId: install.actorId, personal: true },
      "install",
    );
    if (outcome !== "setup_not_permitted")
      return { outcome, delivered: UNCONNECTED_DELIVERED.has(outcome) };
    attempt.connected = true;
    attempt.sending = false;
  }
  // When Teams doesn't name who added the bot, offer linking; the link
  // command answers from the sender's own authenticated message either way.
  const grant =
    active && install.actorId ? await teamsIdentity(deps, active, install.actorId) : null;
  attempt.sending = true;
  await sendTeamsReply(
    app,
    { ...install, threadId: null, personal: true },
    teamsWelcome({
      ...experienceState(true, active, grant, false, { deps, tenantId: install.tenantId }),
      ...(active && grant && install.actorId
        ? await teamsRoutingState(deps, active, {
            actorId: install.actorId,
            subjectId: grant.subjectId,
          })
        : {}),
    }),
  );
  return { outcome: "welcome_sent", delivered: true };
}
/**
 * Help and account commands: fixed replies that never reach the agent.
 * Returns null when the message should continue down the normal path, as
 * "link" does for someone who isn't linked yet. In an organization that
 * isn't connected, help and unlink also carry the way to connect it.
 */
async function answerTeamsCommand(
  deps: ApiRouteDeps,
  app: App,
  m: TeamsMessage,
  i: TeamsInstallation | null,
  command: TeamsCommand,
): Promise<string | null> {
  const active = i?.active ? i : null;
  const unconnected = { deps, tenantId: m.tenantId };
  // The button opens account linking, or the organization's connection when
  // it isn't connected yet; only ever sent in a 1:1 chat.
  const linkUrl = () => proofLink(deps, m, active);
  if (command === "help") {
    const grant = active ? await teamsIdentity(deps, active, m.actorId) : null;
    await sendTeamsReply(
      app,
      m,
      teamsHelp({
        ...experienceState(
          m.personal,
          active,
          grant,
          // Shared conversations only answer once the organization is connected.
          Boolean(active) && teamsSharedConversationsEnabled(deps, m.tenantId),
          unconnected,
        ),
        ...(active && grant && m.personal
          ? await teamsRoutingState(deps, active, {
              actorId: m.actorId,
              subjectId: grant.subjectId,
            })
          : {}),
      }),
      linkUrl,
    );
    return "help_sent";
  }
  if (command === "link") {
    if (!active || !(await teamsIdentity(deps, active, m.actorId))) return null;
    await sendTeamsReply(app, m, teamsAccountReply("already_linked"));
    return "link_already_linked";
  }
  if (!m.personal) {
    await sendTeamsReply(app, m, teamsAccountReply("not_personal"));
    return "unlink_not_personal";
  }
  // The stored link, even when the person has since lost workspace access:
  // anyone may always remove their own link.
  const subjectId = active ? await getTeamsActor(deps.db, active, m.actorId) : null;
  if (!active || !subjectId) {
    await sendTeamsReply(
      app,
      m,
      teamsNotLinkedReply(experienceState(true, active, null, false, unconnected)),
      linkUrl,
    );
    return "unlink_not_linked";
  }
  if (command === "unlink") {
    await sendTeamsReply(app, m, teamsAccountReply("confirm"));
    return "unlink_confirmation_sent";
  }
  await removeTeamsLink(deps.db, active, subjectId);
  await sendTeamsReply(app, m, teamsAccountReply("done"));
  return "unlinked";
}
/** One chat's typing loop: the message it is for and how to tell it's answered. */
export type TeamsTypingLoop = {
  eventId: string;
  pending: () => Promise<boolean>;
  deadline: number;
  /** Bumped when a newer message takes over the loop. */
  version: number;
};
/**
 * Keeps Teams' typing indicator up while the reply to a message is being
 * produced: from the moment the message is accepted until `pending` reports
 * it answered or refused, or `maxMs` passes. One loop per chat; a newer
 * message in the same chat takes over the running loop and restarts its
 * deadline.
 */
export async function keepTeamsTyping(input: {
  loops: Map<string, TeamsTypingLoop>;
  key: string;
  eventId: string;
  send: () => Promise<void>;
  pending: () => Promise<boolean>;
  intervalMs?: number;
  maxMs?: number;
}): Promise<void> {
  const maxMs = input.maxMs ?? 5 * 60_000;
  const live = input.loops.get(input.key);
  if (live) {
    live.eventId = input.eventId;
    live.pending = input.pending;
    live.deadline = Date.now() + maxMs;
    live.version += 1;
    return;
  }
  const state: TeamsTypingLoop = {
    eventId: input.eventId,
    pending: input.pending,
    deadline: Date.now() + maxMs,
    version: 0,
  };
  input.loops.set(input.key, state);
  try {
    for (;;) {
      await input.send();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, input.intervalMs ?? 3000);
        (timer as { unref?: () => void }).unref?.();
      });
      const version = state.version;
      const pending = Date.now() < state.deadline && (await state.pending());
      // A newer message that took over while this was checked keeps the loop going.
      if (!pending && version === state.version) return;
    }
  } finally {
    input.loops.delete(input.key);
  }
}
/** Records a thumbs up or down on an agent reply as Opengeni feedback on its chat and turn. */
export async function recordTeamsFeedback(deps: ApiRouteDeps, f: TeamsFeedback): Promise<string> {
  if (f.botId.toLowerCase() !== `28:${deps.settings.teamsBotClientId!.toLowerCase()}`)
    return "bot_identity_mismatch";
  if (!teamsTenantEnabled(deps.settings, f.tenantId)) return "tenant_disabled";
  if (!teamsConversationAllowed(deps, f)) return "channel_disabled";
  const i = await getTeamsInstallation(deps.db, f.tenantId);
  if (!i?.active) return "feedback_installation_inactive";
  const reply = await getTeamsDeliveredReply(deps.db, i, {
    conversationId: f.conversationId,
    providerMessageId: f.replyToId,
  });
  let grant: AccessGrant | null;
  if (deps.settings.teamsWorkspaceRoutingEnabled && reply?.personal) {
    // With workspace routing a 1:1 chat may run outside the installation's
    // workspace, so its reply is rated with the authority the chat runs with,
    // read live as before every delivery: its linked owner (an active
    // organization member) with their own access to the chat's workspace, or
    // an organization agent's grant while the owner may still use it. Never
    // the installation workspace's.
    const identity = await teamsIdentity(deps, i, f.actorId);
    if (!identity) return "feedback_actor_unlinked";
    if (reply.subject_id !== identity.subjectId) return "feedback_target_missing";
    const actor = await routeActor(deps, i, reply, f.actorId);
    grant = actor && actor.subjectId === reply.subject_id ? actor.grant : null;
  } else {
    // Channels, group chats and installations without routing: as before.
    const identity = await actorGrant(deps, i, f.actorId);
    if (!identity) return "feedback_actor_unlinked";
    if (!reply || (reply.personal && reply.subject_id !== identity.subjectId))
      return "feedback_target_missing";
    grant = reply.session_workspace_id
      ? await ownPersonalWorkspaceGrant(deps, i, identity.subjectId, reply.session_workspace_id)
      : identity;
  }
  // The same permissions the HTTP feedback route requires for feedback on a chat.
  if (
    !grant ||
    !(["workspace:read", "sessions:create", "sessions:read"] as const).every((permission) =>
      hasPermission(grant.permissions, permission),
    )
  )
    return "feedback_not_permitted";
  const save = (turnId: string | null) => () =>
    createFeedback(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      principalKind: grant.principalKind ?? null,
      request: {
        idempotencyKey: teamsEventUuid("teams-feedback", `${i.tenant_id}:${f.eventId}`),
        sessionId: reply.session_id,
        ...(turnId ? { turnId } : {}),
        sentiment: f.sentiment,
        ...(f.comment ? { comment: f.comment } : {}),
      },
      server: { version: deps.settings.serverVersion, revision: deps.settings.deploymentRevision },
    });
  try {
    const authorization = await requireSessionAuthorization(deps, grant, {
      sessionId: reply.session_id,
      operation: "session.feedback.write",
      surface: "core",
    });
    const run = (turnId: string | null) =>
      authorization
        ? withResolvedSessionAuthorization(authorization, save(turnId))
        : save(turnId)();
    let result;
    try {
      result = await run(reply.turn_id);
    } catch (error) {
      // A turn that no longer exists still leaves feedback on the chat.
      if (!(error instanceof FeedbackTargetNotFoundError) || !reply.turn_id) throw error;
      result = await run(null);
    }
    return result.replayed ? "feedback_replayed" : "feedback_recorded";
  } catch (error) {
    // A deleted session, or one this person can no longer see, is treated
    // like the HTTP feedback route treats it: not found.
    if (
      error instanceof FeedbackTargetNotFoundError ||
      error instanceof SessionAuthorizationDeniedError
    )
      return "feedback_target_missing";
    if (error instanceof FeedbackConflictError) return "feedback_conflict";
    if (error instanceof HTTPException && error.status >= 400 && error.status < 500)
      return "feedback_not_permitted";
    throw error;
  }
}
/** Personal chats always; group chats and channels only when allowlisted. */
function teamsConversationAllowed(
  deps: ApiRouteDeps,
  c: Pick<TeamsMessage, "tenantId" | "personal" | "groupChat" | "conversationId" | "channelId">,
): boolean {
  if (c.personal) return true;
  return c.groupChat
    ? deps.settings.teamsBotAllowedGroupChatIds.includes(`${c.tenantId}:${c.conversationId}`)
    : Boolean(c.channelId) &&
        deps.settings.teamsBotAllowedChannelIds.includes(`${c.tenantId}:${c.channelId}`);
}
/**
 * A 1:1 message with a file or image, or no text, is told to send text, in an
 * admitted tenant and within the short-reply budget. It never fails the
 * activity.
 */
async function replyToUnreadableMessage(
  deps: ApiRouteDeps,
  app: App,
  m: NonNullable<ReturnType<typeof teamsUnreadablePersonalMessage>>,
  budgets: TeamsOnboardingBudgets = onboardingBudgets(deps),
): Promise<string> {
  if (!teamsTenantEnabled(deps.settings, m.tenantId)) return "unreadable_message_ignored";
  try {
    const reply = await budgets.reminder.reserve(m.tenantId, m.actorId);
    if (!reply) return "unreadable_message_limited";
    await sendReserved(reply, () => send(app, m, TEAMS_UNREADABLE_MESSAGE_TEXT));
    return "unreadable_message_notice_sent";
  } catch {
    return "unreadable_message_notice_failed";
  }
}
/**
 * A mention in a group chat or channel that isn't turned on gets a short,
 * bounded reply saying so, instead of silence. It never fails the activity.
 */
async function replyToDisabledConversation(
  deps: ApiRouteDeps,
  app: App,
  m: TeamsMessage,
  budgets: TeamsOnboardingBudgets = onboardingBudgets(deps),
): Promise<string> {
  try {
    const reply = await budgets.sharedNotice.reserve(m.tenantId, m.actorId);
    if (!reply) return "channel_disabled";
    await sendReserved(reply, () =>
      send(app, m, teamsAppOffInConversationText(deps.settings.teamsAppName)),
    );
    return "channel_disabled_notice_sent";
  } catch {
    return "channel_disabled_notice_failed";
  }
}
/**
 * Handles one Teams activity. Call it only with an activity the Teams SDK has
 * authenticated (Connector JWT, audience, issuer, expiry and service URL);
 * it never authenticates anything itself.
 */
export async function handleTeamsActivity(
  deps: ApiRouteDeps,
  app: App,
  body: unknown,
): Promise<{ status: number }> {
  const observed = (reason: string) =>
    deps.observability?.info("Teams authenticated activity outcome", { reason });
  const botId = `28:${deps.settings.teamsBotClientId!.toLowerCase()}`;
  const change = teamsGroupMembershipChange(body, botId);
  if (change) {
    const installation = await getTeamsInstallation(deps.db, change.tenantId);
    if (installation?.active) {
      await invalidateTeamsGroup(deps.db, installation, change.conversationId);
      // Someone added to the chat must not get answers built from
      // messages Teams did not show them.
      const added = (body as { membersAdded?: unknown[] } | null)?.membersAdded;
      if (Array.isArray(added) && added.length)
        await clearTeamsContextConversation(
          deps.db,
          installation,
          teamsThreadlessConversationId(change.conversationId),
        );
    }
    return { status: 200 };
  }
  const install = teamsPersonalInstall(body);
  if (install) {
    if (install.botId.toLowerCase() !== botId) observed("bot_identity_mismatch");
    else if (!teamsTenantEnabled(deps.settings, install.tenantId)) observed("tenant_disabled");
    else {
      const welcome = await welcomeTeamsInstall(deps, app, install);
      observed(welcome.outcome);
      return { status: welcome.status };
    }
    return { status: 200 };
  }
  const feedback = normalizeTeamsFeedback(body);
  if (feedback) {
    observed(await recordTeamsFeedback(deps, feedback));
    return { status: 200 };
  }
  // Edits and deletions update recorded context; they never start work.
  try {
    if (await reviseTeamsContext(deps, body)) {
      observed("context_revised");
      return { status: 200 };
    }
  } catch {
    observed("context_revise_failed");
    return { status: 200 };
  }
  const ignored: TeamsMessageRejection[] = [];
  const m = normalizeTeamsMessage(body, (diagnostic) => ignored.push(diagnostic));
  // Every human message in an approved channel or group chat is kept as
  // bounded context for the next mention there, except commands to
  // Opengeni such as "help". Only a mention below starts work; a failed
  // write never blocks it.
  let recorded = false;
  if (!(m && teamsCommand(m.text)))
    try {
      recorded = await recordTeamsContext(deps, body);
      if (recorded) observed("context_recorded");
    } catch {
      observed("context_record_failed");
    }
  for (const diagnostic of ignored) {
    // With resource-specific consent most recorded messages carry no
    // mention: that is expected, not worth a log line each.
    if (recorded && diagnostic.reason === "missing_mention") continue;
    deps.observability?.info("Teams authenticated activity ignored", { ...diagnostic });
  }
  if (!m) {
    const unreadable = teamsUnreadablePersonalMessage(body);
    if (unreadable && unreadable.botId.toLowerCase() === botId) {
      const replies = teamsReplies(deps, app, { ...unreadable, activityId: unreadable.eventId });
      const outcome = await replyToUnreadableMessage(deps, replies.app, unreadable);
      observed(replies.duplicate() ? "reply_duplicate" : outcome);
    }
    return { status: 200 };
  }
  if (m.botId.toLowerCase() !== botId) {
    observed("bot_identity_mismatch");
    return { status: 200 };
  }
  // Replies the bot sends itself are sent once per activity.
  const replies = teamsReplies(deps, app, { ...m, activityId: m.eventId });
  const { once } = replies;
  const duplicate = () => {
    observed("reply_duplicate");
    return { status: 200 };
  };
  // The way forward for people whose organization isn't connected yet; never
  // fails the activity.
  const unconnected = async () => {
    try {
      const outcome = await once(() =>
        replyToUnconnectedTeamsTenant(deps, replies.app, m, "message"),
      );
      observed(outcome === DUPLICATE_REPLY ? "reply_duplicate" : outcome);
    } catch {
      observed("onboarding_reply_failed");
    }
  };
  if (!teamsTenantEnabled(deps.settings, m.tenantId)) {
    await unconnected();
    return { status: 200 };
  }
  if (!teamsConversationAllowed(deps, m)) {
    const outcome = await replyToDisabledConversation(deps, replies.app, m);
    observed(replies.duplicate() ? "reply_duplicate" : outcome);
    return { status: 200 };
  }
  const i = await getTeamsInstallation(deps.db, m.tenantId);
  const command = teamsCommand(m.text);
  if (command) {
    const answered = await once(() => answerTeamsCommand(deps, replies.app, m, i, command));
    if (answered === DUPLICATE_REPLY) return duplicate();
    if (answered) {
      observed(answered);
      return { status: 200 };
    }
  }
  if (!i?.active) {
    await unconnected();
    return { status: 200 };
  }
  // Workspace routing is a 1:1 matter: group chats and channels keep the
  // installation's workspace and read every message as before.
  if (deps.settings.teamsWorkspaceRoutingEnabled && m.personal)
    return await routeTeamsPersonalMessage(deps, app, m, i, replies, observed);
  const grant = await actorGrant(deps, i, m.actorId);
  if (!grant) {
    const sent = await once(async () => {
      // Identity bearers are never sent to channels or shared conversations.
      if (m.personal)
        await sendTeamsOnboarding(
          replies.app,
          m,
          "link",
          proofLink(deps, m, i),
          deps.settings.teamsAppName,
        );
      else
        await send(
          replies.app,
          m,
          "Send me a direct message to link your Opengeni account, then mention me here again.",
        );
    });
    if (sent === DUPLICATE_REPLY) return duplicate();
    return { status: 200 };
  }
  if (!hasPermission(grant.permissions, "sessions:create")) {
    // One person's access is explained only to them.
    try {
      const sent = await once(() =>
        send(replies.app, m, m.personal ? TEAMS_CANNOT_START_TEXT : TEAMS_SHARED_CANNOT_START_TEXT),
      );
      observed(sent === DUPLICATE_REPLY ? "reply_duplicate" : "sessions_create_denied");
    } catch {
      observed("sessions_create_denied_reply_failed");
    }
    return { status: 200 };
  }
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
      const sent = await once(() =>
        send(
          replies.app,
          m,
          "I couldn’t verify this chat’s access. Everyone needs workspace access and a linked Opengeni account. Message me privately to connect, then @mention me here.",
        ),
      );
      if (sent === DUPLICATE_REPLY) return duplicate();
      return { status: 200 };
    }
  }
  // A 1:1 chat lands in the sender's own Personal workspace; channels
  // and group chats stay in the installation's workspace.
  const sessionWorkspaceId = m.personal
    ? await teamsChatPersonalWorkspace(deps, i, grant.subjectId)
    : null;
  const routeId = teamsRouteId(m, i.generation, grant.subjectId, sessionWorkspaceId);
  const eventId = `${m.identity}:${i.generation}`;
  const queued = await enqueueTeamsMessage(deps.db, i, {
    routeId,
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
    eventId,
    payload: m,
  });
  // A redelivered message is already being answered, or was answered.
  if (!queued.queued) return { status: 200 };
  startTeamsTyping(deps, app, m, i, queued, eventId, observed);
  return { status: 200 };
}
/** Shows Teams' typing indicator until the queued message is answered. */
function startTeamsTyping(
  deps: ApiRouteDeps,
  app: App,
  m: TeamsMessage,
  i: TeamsInstallation,
  queued: { routeId: string; replySequence: number },
  eventId: string,
  observed: (reason: string) => void,
): void {
  let loops = typingLoops.get(deps);
  if (!loops) typingLoops.set(deps, (loops = new Map()));
  void keepTeamsTyping({
    loops,
    key: queued.routeId,
    eventId,
    send: () => sendTyping(app, m),
    pending: () => teamsReplyPending(deps.db, i, { eventId, replySequence: queued.replySequence }),
  }).catch(() => {
    // The indicator is a courtesy; the reply is delivered either way.
    observed("typing_stopped");
  });
}

/** What a routed 1:1 message's inbox payload adds: what the first reply names. */
type TeamsRoutedPayload = TeamsMessage & {
  teamsRouting?: {
    workspaceLabel: string;
    agentName: string | null;
    announce: boolean;
    /** A one-off `in <Workspace>: …` message; its replies name the workspace. */
    oneOff?: boolean;
  };
};

/**
 * A linked person's 1:1 message with workspace routing: switch commands,
 * then the route (see teams-routing.ts), then the queue. The person's
 * identity and their access to the chosen workspace are read live here,
 * again inside the enqueue transaction, at session admission and before
 * every delivery. A route that doesn't work is refused with the reason;
 * nothing starts in another workspace instead.
 */
async function routeTeamsPersonalMessage(
  deps: ApiRouteDeps,
  app: App,
  m: TeamsMessage,
  i: TeamsInstallation,
  replies: TeamsReplies,
  observed: (reason: string) => void,
): Promise<{ status: number }> {
  const reply = async (outcome: string, text: string | TeamsExperienceReply) => {
    const sent = await replies.once(() =>
      typeof text === "string" ? send(replies.app, m, text) : sendTeamsReply(replies.app, m, text),
    );
    observed(sent === DUPLICATE_REPLY ? "reply_duplicate" : outcome);
    return { status: 200 };
  };
  const identity = await teamsIdentity(deps, i, m.actorId);
  if (!identity) {
    const sent = await replies.once(() =>
      sendTeamsOnboarding(
        replies.app,
        m,
        "link",
        proofLink(deps, m, i),
        deps.settings.teamsAppName,
      ),
    );
    observed(sent === DUPLICATE_REPLY ? "reply_duplicate" : "link_required");
    return { status: 200 };
  }
  const who = { actorId: m.actorId, subjectId: identity.subjectId };
  const directory = await loadTeamsRouteDirectory(deps.db, i, identity.subjectId);
  const remember = (target: TeamsChatTarget) =>
    setTeamsChatChoice(deps.db, i, { ...who, ...target });
  const optionLabels = (target: TeamsChatTarget) => {
    const agent = target.agentId
      ? directory.agents.find(
          (a) => a.id === target.agentId && a.targetWorkspaceId === target.workspaceId,
        )
      : undefined;
    return {
      // An agent anyone in the organization may use can live in a workspace
      // that isn't one of the person's.
      workspaceLabel:
        directory.candidates.find((c) => c.workspaceId === target.workspaceId)?.label ??
        agent?.targetWorkspaceLabel ??
        "",
      agentName: agent?.name ?? null,
    };
  };
  // A card option counts only while it is still one of the person's options.
  const stillOffered = (target: TeamsChatTarget) => teamsRouteTargetOffered(directory, target);
  const showCard = async (waiting: TeamsMessage | null) => {
    const options = teamsRouteOptions(directory);
    if (options.length === 0) return await reply("route_no_workspace", TEAMS_NO_WORKSPACE_TEXT);
    if (options.length === 1 && !waiting) {
      const only = options[0]!;
      await remember(only);
      return await reply(
        "route_single_choice",
        `You have one ${only.agentId ? "agent" : "workspace"}: **${only.title}**. New messages go there.`,
      );
    }
    await putTeamsRoutePrompt(deps.db, i, {
      ...who,
      payload: waiting ? (waiting as unknown as Record<string, unknown>) : null,
      options,
    });
    void pruneTeamsRoutePrompts(deps.db, i).catch(() => {
      // Pruning is housekeeping; the next card tries again.
    });
    const choice = waiting ? null : await getTeamsChatChoice(deps.db, i, who);
    return await reply(waiting ? "route_asked" : "route_card_sent", {
      text: teamsSwitchCardText(options, choice ? optionLabels(choice) : null, Boolean(waiting)),
      choices: options.map((option, index) => ({
        title: `${index + 1}. ${option.title}`,
        command: `switch ${index + 1}`,
      })),
    });
  };

  const command = teamsSwitchCommand(m.text);
  if (command?.kind === "list") return await showCard(null);
  if (command?.kind === "pick") {
    const taken = await takeTeamsRoutePromptOption(deps.db, i, {
      ...who,
      position: command.position,
    });
    if (!taken || !stillOffered(taken.target))
      return await reply(
        "route_choice_expired",
        "That choice is no longer available. Send **switch** to see your workspaces and agents again.",
      );
    await remember(taken.target);
    const labels = optionLabels(taken.target);
    const waiting = taken.payload as TeamsMessage | null;
    if (!waiting) return await reply("route_switched", teamsSwitchedText(labels));
    return await enqueueRoutedMessage(deps, app, i, waiting, identity.subjectId, {
      target: taken.target,
      text: waiting.text,
      ...labels,
      announce: true,
      directory,
      replies,
      observed,
    });
  }
  const named = command?.kind === "named" ? teamsRouteOptionNamed(directory, command.name) : null;
  // "switch to dark mode" names nothing here: it's a request, not a switch.
  // A single unknown word ("switch Desgin") is most likely a typo.
  if (command?.kind === "named" && (named || !/\s/u.test(command.name.trim()))) {
    const option = named;
    if (option === "ambiguous")
      return await reply(
        "route_choice_ambiguous",
        `More than one workspace or agent is called **${command.name}**. Send **switch** and pick one by number.`,
      );
    if (!option)
      return await reply(
        "route_choice_unknown",
        `You have no workspace or agent called **${command.name}**. Send **switch** to see them.`,
      );
    await remember(option);
    return await reply("route_switched", teamsSwitchedText(optionLabels(option)));
  }

  const choice = await getTeamsChatChoice(deps.db, i, who);
  const resolution = resolveTeamsRoute({
    text: m.text,
    appName: deps.settings.teamsAppName,
    directory,
    choice,
  });
  switch (resolution.kind) {
    case "denied": {
      if (resolution.forgetChoice) {
        await clearTeamsChatChoice(deps.db, i, who);
        // A workspace the person can no longer see is still named to them.
        if (choice && !directory.candidates.some((c) => c.workspaceId === choice.workspaceId))
          return await reply(
            "route_choice_unavailable",
            teamsChoiceUnavailableText(
              await teamsWorkspaceName(deps.db, {
                accountId: i.account_id,
                workspaceId: choice.workspaceId,
              }),
            ),
          );
      }
      return await reply("route_denied", resolution.text);
    }
    case "switched":
      await remember(resolution.target);
      return await reply("route_switched", teamsSwitchedText(resolution));
    case "ask":
      return await showCard(m);
    case "resolved":
      if (resolution.remember) await remember(resolution.target);
      return await enqueueRoutedMessage(deps, app, i, m, identity.subjectId, {
        ...resolution,
        oneOff: resolution.source === "prefix",
        directory,
        replies,
        observed,
      });
  }
}

/** What Teams says about the sender of a 1:1 message, or null when it can't say. */
async function readTeamsSender(app: App, m: TeamsMessage): Promise<TeamsMemberFacts | null> {
  try {
    const member = await app.api
      .fromServiceUrl({ serviceUrl: teamsServiceUrl(m.serviceUrl) })
      .conversations.getMemberById(m.conversationId, m.actorId);
    return member && typeof member === "object" ? (member as TeamsMemberFacts) : null;
  } catch {
    return null;
  }
}

/**
 * Queues a routed 1:1 message once the person's live access to its
 * workspace holds. Someone that workspace doesn't let start chats can still
 * ask an agent anyone in the organization may use, as the agent (see
 * teams-organization-agents.ts), when Teams says they are a full member of
 * the tenant; members keep their own chat, unchanged.
 */
async function enqueueRoutedMessage(
  deps: ApiRouteDeps,
  app: App,
  i: TeamsInstallation,
  m: TeamsMessage,
  subjectId: string,
  route: {
    target: TeamsChatTarget;
    text: string;
    workspaceLabel: string;
    agentName: string | null;
    announce: boolean;
    /** A one-off `in <Workspace>: …` message: its replies name the workspace. */
    oneOff?: boolean;
    directory: TeamsRouteDirectory;
    replies: TeamsReplies;
    observed: (reason: string) => void;
  },
): Promise<{ status: number }> {
  const { target, replies, observed } = route;
  const reply = async (outcome: string, text: string) => {
    const sent = await replies.once(() => send(replies.app, m, text));
    observed(sent === DUPLICATE_REPLY ? "reply_duplicate" : outcome);
    return { status: 200 };
  };
  const canStart = async (db: ApiRouteDeps["db"]) => {
    const grant = await teamsTargetGrant(db, i, subjectId, target.workspaceId);
    return Boolean(grant && hasPermission(grant.permissions, "sessions:create"));
  };
  const refuse = async () =>
    await reply(
      "sessions_create_denied",
      `Your Opengeni account can't start chats in **${route.workspaceLabel || "that workspace"}**. Send **switch** to choose another workspace. No chat was started.`,
    );
  // The agent in that workspace, read live in `db` (the enqueue transaction).
  const liveAgent = async (db: ApiRouteDeps["db"], agentId: string) => {
    const agent = await getTeamsAgentInWorkspace(db, {
      accountId: i.account_id,
      workspaceId: target.workspaceId,
      agentId,
    });
    return agent && agent.accountId === i.account_id ? agent : null;
  };
  const directoryAgent = target.agentId
    ? (route.directory.agents.find(
        (agent) => agent.id === target.agentId && agent.targetWorkspaceId === target.workspaceId,
      ) ?? null)
    : null;
  // The installation's own workspace keeps a route with no session workspace,
  // as before; any other workspace is named on the route and checked again in
  // the enqueue transaction.
  const sessionWorkspaceId = target.workspaceId === i.workspace_id ? null : target.workspaceId;
  const eventId = `${m.identity}:${i.generation}`;
  let senderChecked = false;
  for (let attempt = 0; ; attempt += 1) {
    const member = await canStart(deps.db);
    const organizationAgent = !member && directoryAgent?.open ? directoryAgent : null;
    if (!member && !organizationAgent) return await refuse();
    if (organizationAgent && !senderChecked) {
      senderChecked = true;
      // Teams must say this is a full member of the connected tenant, and
      // Opengeni that the linked person is an active member of the
      // organization (as Slack asks of its open agents).
      if (
        !teamsFullTenantMember(await readTeamsSender(app, m), {
          tenantId: i.tenant_id,
          actorId: m.actorId,
        })
      )
        return await reply(
          "organization_agent_not_eligible",
          teamsOrganizationAgentNotEligibleText(organizationAgent.name),
        );
      const person = await organizationAgentAskerPerson(deps.db, {
        connectionAccountId: i.account_id,
        agentAccountId: organizationAgent.targetAccountId,
        linkedSubjectId: subjectId,
      });
      if ("refusal" in person)
        return await reply(
          "organization_agent_person_refused",
          teamsOrganizationAgentMembersOnlyText(organizationAgent.name),
        );
    }
    const routeId = organizationAgent
      ? teamsOrganizationAgentRouteId(
          m,
          i.generation,
          subjectId,
          sessionWorkspaceId,
          organizationAgent.id,
        )
      : teamsRouteId(m, i.generation, subjectId, sessionWorkspaceId, target.agentId);
    const payload: TeamsRoutedPayload = {
      ...m,
      text: route.text,
      teamsRouting: {
        workspaceLabel: route.workspaceLabel,
        agentName: route.agentName,
        // An organization agent's first reply always says where it went and
        // who can see it.
        announce: route.announce || Boolean(organizationAgent),
        ...(route.oneOff ? { oneOff: true } : {}),
      },
    };
    let queued: Awaited<ReturnType<typeof enqueueTeamsMessage>>;
    try {
      queued = await enqueueTeamsMessage(deps.db, i, {
        routeId,
        actorId: m.actorId,
        subjectId,
        personal: true,
        sessionWorkspaceId,
        authorizeSessionWorkspace: async (tx, checked) => {
          if (checked.workspaceId !== target.workspaceId || checked.agentId !== target.agentId)
            return false;
          if (organizationAgent)
            return Boolean(
              (await namedSubjectIsActiveOrganizationMember(tx, {
                accountId: i.account_id,
                subjectId,
              })) &&
              (await liveAgent(tx, organizationAgent.id))?.organizationAccess &&
              (await teamsWorkspaceInReach(tx, i, subjectId, target.workspaceId)),
            );
          return (
            (await canStart(tx)) &&
            (!checked.agentId || Boolean(await liveAgent(tx, checked.agentId)))
          );
        },
        agentId: target.agentId,
        channelId: null,
        conversationId: m.conversationId,
        threadId: m.threadId,
        serviceUrl: m.serviceUrl,
        botId: m.botId,
        eventId,
        payload,
      });
    } catch (error) {
      // The organization's reach changed while access was checked: check again, once.
      if (error instanceof Error && error.message === "teams_reach_changed" && attempt === 0)
        continue;
      // Access changed between the check above and the queue's own check.
      if (
        error instanceof Error &&
        (error.message === "teams_route_unavailable" || error.message === "teams_reach_changed")
      )
        return organizationAgent
          ? await reply(
              "organization_agent_unavailable",
              teamsOrganizationAgentUnavailableText(organizationAgent.name),
            )
          : await refuse();
      throw error;
    }
    if (!queued.queued) return { status: 200 };
    startTeamsTyping(deps, app, m, i, queued, eventId, observed);
    return { status: 200 };
  }
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
      app.server.onRequest = async ({ body }) => handleTeamsActivity(deps, app, body);
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
/**
 * The signed-in person linking their Teams account in an installation's
 * workspace. Without workspace routing they need to start chats there. With
 * it, linking is an organization matter (any active full member, checked
 * with the proof), so only a signed-in human browser session is required.
 */
async function teamsLinker(c: Context, deps: ApiRouteDeps): Promise<TeamsLinker> {
  if (!deps.settings.teamsWorkspaceRoutingEnabled) {
    const human = await browserHuman(c, deps);
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId")!, "sessions:create");
    if (grant.subjectId !== human.subjectId) throw new HTTPException(403);
    return grant;
  }
  if (c.req.header("authorization"))
    throw new HTTPException(401, {
      message: "Sign in with your Opengeni account to link Teams.",
    });
  // Unauthenticated requests still get a 401 here.
  const context = await requireAccessContext(c, deps);
  // Only a person signed in to Opengeni themselves in their browser links
  // their Teams account: never a delegated person (an agent's app actions, a
  // published Site's viewer), a key or a service.
  const subjectId = await managedHumanSubjectForRequest(c, deps);
  if (context.mode !== "managed" || !subjectId || subjectId !== context.subjectId)
    throw new HTTPException(403, { message: "A signed-in human account is required." });
  return { subjectId, workspaceId: c.req.param("workspaceId")! };
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
    appName: deps.settings.teamsAppName,
    // People's 1:1 chats can start work in other workspaces of the organization.
    workspaceRouting: deps.settings.teamsWorkspaceRoutingEnabled,
    setupAvailable:
      configured &&
      enabled &&
      (deps.settings.teamsBotSetupAdminIds.length > 0 ||
        deps.settings.teamsBotSelfServeSetupEnabled),
    installation: i
      ? { tenantId: i.tenant_id, workspaceId: i.workspace_id, active: i.active }
      : null,
    delivery: i
      ? await teamsDeliveryStatus(deps.db, i, subjectId)
      : { pending: 0, unknown: 0, failed: 0 },
    linked: Boolean(i?.active && (await getOwnTeamsLink(deps.db, i, subjectId))),
  };
}
/** Neither an operator-approved installer nor a tenant that may set itself up. */
function setupUnavailable(tenantId: string) {
  return teamsConnectionRefused(
    teamsSelfServeTenantAllowed(tenantId) ? "setup_unavailable" : "consumer_tenant",
  );
}
function setupProof(deps: ApiRouteDeps, token: string): TeamsLinkProof {
  let p: TeamsLinkProof;
  try {
    p = proof(deps, token);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 400)
      throw teamsConnectionRefused("setup_link_invalid");
    throw error;
  }
  if (p.purpose !== "setup" || p.workspaceId !== null || p.generation !== null)
    throw teamsConnectionRefused("setup_link_invalid");
  if (!teamsTenantEnabled(deps.settings, p.tenantId)) throw setupUnavailable(p.tenantId);
  return p;
}
function operatorApprovedInstaller(deps: ApiRouteDeps, p: TeamsLinkProof): boolean {
  return deps.settings.teamsBotSetupAdminIds.includes(`${p.tenantId}:${p.actorId}`);
}
async function requireSetupWorkspace(
  deps: ApiRouteDeps,
  workspaceId: string,
  tenantId: string,
): Promise<void> {
  const workspace = await getWorkspace(deps.db, workspaceId);
  if (workspace?.kind !== "shared") throw teamsConnectionRefused("shared_workspace_required");
  const existing = await getWorkspaceTeamsInstallation(deps.db, workspaceId);
  if (existing && existing.tenant_id !== tenantId)
    throw teamsConnectionRefused("workspace_linked_elsewhere");
}
function teamsAdminSignInConfig(deps: ApiRouteDeps): TeamsAdminSignInConfig {
  return {
    clientId: deps.settings.teamsBotClientId!,
    clientSecret: deps.settings.teamsBotClientSecret!,
    stateSecret: deps.settings.integrationsStateSecret!,
    redirectUri: new URL("/teams/connect", configuredBase(deps)).toString(),
  };
}
/**
 * The Microsoft sign-in must belong to this exact setup (proof nonce, tenant,
 * Teams user, Opengeni person and workspace). Self-serve setup also proves a
 * tenant administrator; an operator-approved installer proves only that they
 * are the Teams user the setup link names.
 */
async function requireSetupSignIn(
  deps: ApiRouteDeps,
  p: TeamsLinkProof,
  grant: AccessGrant,
  microsoft: { code: string; state: string },
  purpose: "teams-admin-setup" | "teams-installer-setup",
): Promise<TeamsAdminIdentity> {
  const config = teamsAdminSignInConfig(deps);
  try {
    const state = verifyTeamsAdminState(config.stateSecret, microsoft.state);
    if (
      state.purpose !== purpose ||
      state.proofNonce !== p.nonce ||
      state.tenantId !== p.tenantId ||
      state.actorId !== p.actorId ||
      state.subjectId !== grant.subjectId ||
      state.workspaceId !== grant.workspaceId
    )
      throw new TeamsAdminProofError("state_mismatch");
    return await verifyTeamsAdminSignIn(config, state, microsoft.code, deps.teamsAdminSignInFetch);
  } catch (error) {
    if (!(error instanceof TeamsAdminProofError)) throw error;
    deps.observability?.info("Teams self-serve setup refused", { reason: error.code });
    throw teamsConnectionRefused(error.code);
  }
}
/**
 * Starts setup for a verified browser human who administers `grant`'s shared
 * workspace. Returns the Microsoft sign-in URL that proves a tenant
 * administrator or, for an installer the operator approved, only that they
 * are the Teams user the setup link names.
 */
export async function startTeamsSetupSignIn(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  setupToken: string,
): Promise<{ authorizationUrl: string | null }> {
  const p = setupProof(deps, setupToken);
  await requireSetupWorkspace(deps, grant.workspaceId, p.tenantId);
  const approved = operatorApprovedInstaller(deps, p);
  if (!approved && !teamsSelfServeSetupAvailable(deps.settings, p.tenantId))
    throw setupUnavailable(p.tenantId);
  // Microsoft can only prove a work or school identity.
  if (approved && !teamsSelfServeTenantAllowed(p.tenantId))
    throw teamsConnectionRefused("consumer_tenant");
  const config = teamsAdminSignInConfig(deps);
  const { token, state } = mintTeamsAdminState(config.stateSecret, {
    purpose: approved ? "teams-installer-setup" : "teams-admin-setup",
    proofNonce: p.nonce,
    tenantId: p.tenantId,
    actorId: p.actorId,
    subjectId: grant.subjectId,
    workspaceId: grant.workspaceId,
  });
  return { authorizationUrl: teamsAdminAuthorizationUrl(config, token, state) };
}

/**
 * Binds the Teams tenant to `grant`'s shared workspace for a verified browser
 * human who administers it, and links the installer. It needs the Microsoft
 * sign-in from `startTeamsSetupSignIn`: as a tenant administrator, or, for an
 * installer the operator approved, as the Teams user the setup link names.
 */
export async function completeTeamsSetup(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  input: {
    setupToken: string;
    microsoft?: { code: string; state: string } | undefined;
    /**
     * The installer's Opengeni account may be linked to another Teams account
     * in this workspace: remove only that link, after the administrator and
     * the binding are verified, so a refused setup changes nothing.
     */
    replaceOwnLink?: boolean | undefined;
  },
) {
  const { setupToken, microsoft, replaceOwnLink } = input;
  const p = setupProof(deps, setupToken);
  const approved = operatorApprovedInstaller(deps, p);
  let admin: TeamsAdminIdentity | null = null;
  if (approved) {
    // The installer's Teams account is linked below, so prove who they are
    // before anything else, as for any account link.
    if (!microsoft) throw teamsConnectionRefused("microsoft_sign_in_required");
    await requireSetupSignIn(deps, p, grant, microsoft, "teams-installer-setup");
  } else {
    if (!teamsSelfServeSetupAvailable(deps.settings, p.tenantId))
      throw setupUnavailable(p.tenantId);
    if (!microsoft) throw teamsConnectionRefused("microsoft_sign_in_required");
    // Prove the tenant administrator before revealing anything about the
    // tenant's existing binding.
    admin = await requireSetupSignIn(deps, p, grant, microsoft, "teams-admin-setup");
  }
  const workspace = await getWorkspace(deps.db, grant.workspaceId);
  if (workspace?.kind !== "shared") throw teamsConnectionRefused("shared_workspace_required");
  const existingTenant = await getTeamsInstallation(deps.db, p.tenantId);
  // A Global Administrator may move a disconnected binding to this workspace,
  // so a binding left behind by someone else never locks the organization out.
  // An active binding is never moved or replaced through self-serve setup.
  let release: TeamsInstallation | null = null;
  if (existingTenant && existingTenant.workspace_id !== grant.workspaceId) {
    if (existingTenant.active) throw teamsConnectionRefused("connected_elsewhere");
    if (!admin) throw teamsConnectionRefused("linked_elsewhere");
    if (
      !admin.roles.some((role) => role.toLowerCase() === TEAMS_ADMIN_ROLE_IDS.globalAdministrator)
    )
      throw teamsConnectionRefused("move_requires_global_admin");
    release = existingTenant;
  }
  // Self-serve setup connects a new organization or reconnects a paused
  // binding in its own workspace. It never replaces an active installation.
  if (!approved && existingTenant?.active) throw teamsConnectionRefused("already_connected");
  const existingWorkspace = await getWorkspaceTeamsInstallation(deps.db, grant.workspaceId);
  if (existingWorkspace && existingWorkspace.tenant_id !== p.tenantId)
    throw teamsConnectionRefused("workspace_linked_elsewhere");
  // The old workspace's audit names the Microsoft administrator whose
  // authority moved the binding, not an Opengeni identity from elsewhere.
  const replaceInactive =
    release && admin
      ? {
          installation: release,
          audit: {
            subjectId: `microsoft:${admin.tenantId}:${admin.actorId}`,
            source: "app" as const,
            principalKind: "microsoft_global_administrator",
          },
        }
      : null;
  const install = () =>
    installTeamsBot(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      tenantId: p.tenantId,
      actorId: p.actorId,
      subjectId: grant.subjectId,
      nonce: p.nonce,
      requireInactive: !approved,
      replaceInactive,
    });
  try {
    try {
      await install();
    } catch (error) {
      if (
        !replaceOwnLink ||
        !existingWorkspace ||
        teamsLinkConflict(error) !== "opengeni_account_linked"
      )
        throw error;
      // The conflicting link is the caller's own in this workspace's
      // installation, which is this tenant's. Nothing else is removed.
      await removeTeamsLink(deps.db, existingWorkspace, grant.subjectId);
      await install();
    }
  } catch (error) {
    const cause = error as {
      constraint_name?: string;
      cause?: { constraint_name?: string };
      message?: string;
    };
    if (cause.message === "teams_tenant_already_bound")
      throw teamsConnectionRefused("linked_elsewhere");
    if (cause.message === "teams_installation_changed")
      throw teamsConnectionRefused("connection_changed");
    if (cause.message === "teams_installation_already_active")
      throw teamsConnectionRefused("already_connected");
    if (
      (cause.constraint_name ?? cause.cause?.constraint_name) ===
      "teams_bot_installations_workspace_id_key"
    )
      throw teamsConnectionRefused("workspace_linked_elsewhere");
    // One link per person on each side: the installer is told which side is
    // already linked, never to whom. The page offers to unlink their own.
    const conflict = teamsLinkConflict(error);
    if (conflict)
      throw teamsConnectionRefused(
        conflict === "proof_used"
          ? "setup_link_used"
          : conflict === "other"
            ? "connection_changed"
            : conflict,
      );
    throw error;
  }
  deps.observability?.info("Teams organization connected", {
    method: approved ? "operator_approved" : "tenant_administrator",
    movedDisconnectedBinding: Boolean(replaceInactive),
  });
  if (p.conversation) {
    const conversation = p.conversation;
    void runtime(deps)
      .then((bot) => confirmTeamsSetup(bot, conversation))
      .catch(() => deps.observability?.info("Teams setup confirmation not delivered", {}));
  }
  return await status(deps, grant.workspaceId, grant.subjectId);
}
/** Who is linking, and the installation workspace the link is for. */
type TeamsLinker = Pick<AccessGrant, "subjectId" | "workspaceId">;
/**
 * The account-link proof, when it belongs to the linker's workspace and its
 * current installation. With workspace routing the linker must be an active
 * full member of the installation's organization (read live), as for a Slack
 * link by organization membership; without it, their grant in the
 * installation's workspace already decided.
 */
async function currentLinkProof(
  deps: ApiRouteDeps,
  grant: TeamsLinker,
  token: string,
): Promise<{ p: TeamsLinkProof; i: TeamsInstallation }> {
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
  if (
    deps.settings.teamsWorkspaceRoutingEnabled &&
    !(await namedSubjectIsActiveOrganizationMember(deps.db, {
      accountId: i.account_id,
      subjectId: grant.subjectId,
    }))
  )
    throw teamsConnectionRefused("link_not_organization_member");
  return { p, i };
}
/**
 * Starts the Microsoft sign-in that proves the person opening an account link
 * is the Teams user it names. Any member can link their own Teams account, so
 * it needs no administrator role.
 */
export async function startTeamsLinkSignIn(
  deps: ApiRouteDeps,
  grant: TeamsLinker,
  token: string,
): Promise<{ authorizationUrl: string }> {
  const { p } = await currentLinkProof(deps, grant, token);
  if (!teamsSelfServeTenantAllowed(p.tenantId))
    throw teamsConnectionRefused("link_consumer_tenant");
  const config = teamsAdminSignInConfig(deps);
  const { token: stateToken, state } = mintTeamsAdminState(config.stateSecret, {
    purpose: "teams-account-link",
    proofNonce: p.nonce,
    tenantId: p.tenantId,
    actorId: p.actorId,
    subjectId: grant.subjectId,
    workspaceId: grant.workspaceId,
  });
  return { authorizationUrl: teamsAdminAuthorizationUrl(config, stateToken, state) };
}
/**
 * The Microsoft sign-in must belong to this exact link (proof nonce, tenant,
 * Teams user, Opengeni person and workspace) and be that Teams user: `tid` and
 * `oid` equal the link's tenant and Teams user.
 */
async function requireLinkedMicrosoftIdentity(
  deps: ApiRouteDeps,
  p: TeamsLinkProof,
  grant: TeamsLinker,
  microsoft: { code: string; state: string },
): Promise<void> {
  const config = teamsAdminSignInConfig(deps);
  try {
    const state = verifyTeamsAdminState(config.stateSecret, microsoft.state);
    if (
      state.purpose !== "teams-account-link" ||
      state.proofNonce !== p.nonce ||
      state.tenantId !== p.tenantId ||
      state.actorId !== p.actorId ||
      state.subjectId !== grant.subjectId ||
      state.workspaceId !== grant.workspaceId
    )
      throw new TeamsAdminProofError("state_mismatch");
    await verifyTeamsAdminSignIn(config, state, microsoft.code, deps.teamsAdminSignInFetch);
  } catch (error) {
    if (!(error instanceof TeamsAdminProofError)) throw error;
    deps.observability?.info("Teams account link refused", { reason: error.code });
    switch (error.code) {
      case "tenant_mismatch":
      case "user_mismatch":
        throw teamsLinkIdentityMismatch(p.actorName, error.signedInAs);
      case "consumer_tenant":
        throw teamsConnectionRefused("link_consumer_tenant");
      case "state_invalid":
      case "state_expired":
      case "state_mismatch":
        throw teamsConnectionRefused("link_sign_in_expired");
      default:
        throw teamsConnectionRefused("link_sign_in_failed");
    }
  }
}
/**
 * Links the signed-in person to the Teams account a link proof names, in the
 * workspace's current installation, once a Microsoft sign-in from
 * `startTeamsLinkSignIn` proves they are that Teams user. A link proof alone
 * is not enough: whoever it is forwarded to can't link someone else's Teams
 * account to themselves. One Teams account per Opengeni account in a
 * workspace and one Opengeni account per Teams account: a conflict says which
 * side is already linked, never to whom.
 */
export async function linkTeamsAccount(
  deps: ApiRouteDeps,
  grant: TeamsLinker,
  input: { token: string; microsoft?: { code: string; state: string } | undefined },
) {
  const { p, i } = await currentLinkProof(deps, grant, input.token);
  if (!input.microsoft) throw teamsConnectionRefused("link_sign_in_required");
  // Prove the Teams identity before revealing anything about existing links.
  await requireLinkedMicrosoftIdentity(deps, p, grant, input.microsoft);
  try {
    await linkTeamsActor(deps.db, i, {
      actorId: p.actorId,
      subjectId: grant.subjectId,
      nonce: p.nonce,
    });
  } catch (error) {
    const conflict =
      (error as { message?: unknown } | null)?.message === "teams_installation_changed"
        ? "other"
        : teamsLinkConflict(error);
    if (!conflict) throw error;
    throw teamsConnectionRefused(
      conflict === "proof_used"
        ? "link_used"
        : conflict === "other"
          ? "link_changed"
          : conflict === "opengeni_account_linked"
            ? "link_opengeni_account_linked"
            : conflict,
    );
  }
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
  app.post(`${ROOT}/bot/microsoft-sign-in`, async (c) => {
    const human = await browserHuman(c, deps);
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId"), "workspace:admin");
    if (grant.subjectId !== human.subjectId) throw new HTTPException(403);
    const { setupToken } = await parseRequestJson(
      c,
      z.object({ setupToken: z.string().max(4096) }).strict(),
    );
    return c.json(await startTeamsSetupSignIn(deps, grant, setupToken));
  });
  app.put(`${ROOT}/bot`, async (c) => {
    const human = await browserHuman(c, deps);
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId"), "workspace:admin");
    if (grant.subjectId !== human.subjectId) throw new HTTPException(403);
    const input = await parseRequestJson(
      c,
      z
        .object({
          setupToken: z.string().max(4096),
          microsoft: z
            .object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(4096) })
            .strict()
            .optional(),
          replaceOwnLink: z.boolean().optional(),
        })
        .strict(),
    );
    return c.json(await completeTeamsSetup(deps, grant, input));
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
  app.post(`${ROOT}/link/microsoft-sign-in`, async (c) => {
    const grant = await teamsLinker(c, deps);
    const { token } = await parseRequestJson(c, z.object({ token: z.string().max(4096) }).strict());
    return c.json(await startTeamsLinkSignIn(deps, grant, token));
  });
  app.post(`${ROOT}/link`, async (c) => {
    const grant = await teamsLinker(c, deps);
    const input = await parseRequestJson(
      c,
      z
        .object({
          token: z.string().max(4096),
          microsoft: z
            .object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(4096) })
            .strict()
            .optional(),
        })
        .strict(),
    );
    await linkTeamsAccount(deps, grant, input);
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

/**
 * An agent's reply as Teams message parts. Claude citation tags left in the
 * text become their quoted text instead of raw markup; links the Claude
 * transport already made from them stay Markdown links. Source links lose the
 * tracking a hosted web search tagged onto them. Markdown Teams can't show in a
 * text message is rewritten into what it can (see teamsMarkdown).
 */
export function teamsReplyParts(text: string): string[] {
  return teamsTextParts(teamsMarkdown(withoutProviderTrackingInText(rewriteClaudeCiteTags(text))));
}

/** Message parts within the Teams size limit; code blocks survive a split. */
export function teamsTextParts(text: string): string[] {
  return teamsMarkdownParts(text);
}
type TeamsSender = (
  message: Pick<TeamsMessage, "serviceUrl" | "conversationId" | "threadId" | "botId">,
  text: string,
  options?: { ai?: boolean; link?: TeamsNoticeLink },
) => Promise<string | null>;
/** Opens the chat's session in Opengeni. */
function sessionLink(deps: ApiRouteDeps, r: TeamsRoute): TeamsNoticeLink {
  return { title: "Open in Opengeni", url: sessionUrl(deps, r) };
}
/**
 * Queues a notice about the chat's session. It is sent as a card with a
 * button that opens the session. The stored text also writes the URL out
 * after `lead`, which is what a replica from before notice cards sends
 * during a rolling deploy, so the session stays reachable from Teams.
 */
async function enqueueSessionNotice(
  deps: ApiRouteDeps,
  i: TeamsInstallation,
  r: TeamsRoute,
  sequence: number,
  notice: { card: string; lead: string; after?: string },
): Promise<void> {
  const legacy = `${notice.lead}: ${sessionUrl(deps, r)}${notice.after ? `\n\n${notice.after}` : ""}`;
  await enqueueTeamsOutput(deps.db, i, r, sequence, [legacy], undefined, undefined, {
    link: "session",
    text: notice.after ? `${notice.card}\n\n${notice.after}` : notice.card,
  });
}
function admissionNotice(
  deps: ApiRouteDeps,
  r: TeamsRoute,
  kind: "admission" | "audience_changed",
): { text: string; link: TeamsNoticeLink } {
  const url = new URL(`/workspaces/${r.workspace_id}/plugins`, configuredBase(deps)).toString();
  return kind === "audience_changed"
    ? {
        text: "This chat's visibility changed, so your message was not added. Continue in Opengeni.",
        link: { title: "Continue in Opengeni", url },
      }
    : {
        text: "Opengeni could not start this task. Check your workspace access and chat settings in Opengeni.",
        link: { title: "Open Opengeni", url },
      };
}
/** What every Teams chat's agent is told about Teams. */
const TEAMS_SESSION_INSTRUCTIONS =
  "This conversation is delivered through Microsoft Teams. Replies are short by default: lead with the answer or outcome and any essential next step in a few sentences. Avoid headers, long lists, repeated conclusions, and detailed investigation logs unless the person asks for detail or the task requires it. Summarize completed work rather than narrating every step; preserve information needed to act or understand a material limitation. Human approvals and private information requests must be completed in the authenticated Opengeni chat.";
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
  const organizationAgent = isTeamsOrganizationAgentRoute(r);
  // The route's agent and its workspace's name, read once per drain.
  let agentLabel: Promise<{ name: string; workspaceName: string } | null> | undefined;
  const routeAgentLabel = () =>
    (agentLabel ??= r.agent_id
      ? teamsAgentLabel(deps.db, { accountId: i.account_id, agentId: r.agent_id })
      : Promise.resolve(null));
  const inbound = await getTeamsPendingMessage(deps.db, i, r);
  if (inbound) {
    const actor = await routeActor(deps, i, r, inbound.actor_id);
    if (
      !actor ||
      actor.subjectId !== inbound.subject_id ||
      !hasPermission(actor.grant.permissions, "sessions:create") ||
      (r.personal && actor.subjectId !== r.subject_id)
    ) {
      await settleTeamsMessage(deps.db, i, r, inbound.event_id, "teams_actor_access_revoked");
      return;
    }
    const { grant } = actor;
    const text = inbound.payload.text;
    if (typeof text !== "string") throw new Error("teams_inbox_payload_invalid");
    // Recorded channel or group chat messages before this mention: since the
    // previous mention when it continues the conversation's chat.
    const modelContext = await loadTeamsMentionModelContext(
      deps,
      i,
      inbound.payload,
      r.session_bound,
    );
    const scoped = await catalogDeps(deps, grant);
    const admissionActor = await routeActor(deps, i, r, inbound.actor_id);
    if (
      !(await currentInstallation(deps, i)) ||
      admissionActor?.subjectId !== inbound.subject_id ||
      !(await renewTeamsRoute(deps.db, i, r))
    )
      return;
    try {
      let turnId: string | null;
      // Set when the route's agent went away and a plain chat answers instead.
      let agentDropped = false;
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
        const createRouteSession = async (agentId: string | null) =>
          createSessionForRequest(
            scoped,
            grant,
            routeSessionWorkspace(r),
            {
              requestedSessionId: r.session_id,
              ...(agentId ? { agentId } : {}),
              initialMessage: text,
              ...(modelContext ? { modelContext } : {}),
              // An organization agent's chat belongs to its workspace, whose
              // members can see it; every other 1:1 chat is Only me.
              visibility: r.personal && !organizationAgent ? "private" : "workspace",
              idempotencyKey: `teams:${r.route_id}`,
              clientEventId: inbound.event_id,
              instructions: organizationAgent
                ? `${TEAMS_SESSION_INSTRUCTIONS}\n\n${teamsOrganizationAgentInstructions(
                    (await routeAgentLabel())?.workspaceName ?? null,
                  )}`
                : TEAMS_SESSION_INSTRUCTIONS,
              ...(organizationAgent ? teamsOrganizationAgentSessionOptions(deps.settings) : {}),
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
        // An agent that went away between routing and create answers as a
        // plain chat in the same workspace, as in Slack. An organization
        // agent's chat is the agent's or nothing.
        const created = await createRouteSession(r.agent_id ?? null).catch((error: unknown) => {
          if (r.agent_id && error instanceof SessionAgentNotFoundError) {
            if (organizationAgent)
              throw new HTTPException(403, { message: "teams_organization_agent_unavailable" });
            agentDropped = true;
            return createRouteSession(null);
          }
          throw error;
        });
        turnId = created.initialTurnId;
      } else {
        const accepted = await acceptSessionUserMessage(
          scoped,
          grant,
          routeSessionWorkspace(r),
          r.session_id,
          {
            text,
            ...(modelContext ? { modelContext } : {}),
            clientEventId: inbound.event_id,
            teamsConversation: {
              routeId: r.route_id,
              eventId: inbound.event_id,
              leaseToken: r.lease_token!,
              installationGeneration: i.generation,
            },
          },
        );
        turnId = accepted.turn.id;
      }
      // With routing, the first reply of a new chat names where it went when
      // routing made a real choice.
      const routing = (inbound.payload as TeamsRoutedPayload).teamsRouting;
      const where =
        routing?.announce && routing.workspaceLabel
          ? ` in **${routing.workspaceLabel}**${routing.agentName && !agentDropped ? ` with **${routing.agentName}**` : ""}`
          : "";
      const disclaimer = `${deps.settings.teamsAppName} is an AI agent and can make mistakes. Send **help** for tips and commands.`;
      if (!r.session_bound && organizationAgent) {
        // Only the workspace's members can open this chat, so no link. The
        // person is told once, on their chat's first reply, who can see it.
        const agent = await routeAgentLabel();
        await enqueueTeamsOutput(deps.db, i, r, 0, [
          [
            `Started${where}.`,
            teamsOrganizationAgentNoticeText(
              agent?.name ?? routing?.agentName ?? "This agent",
              agent?.workspaceName ?? routing?.workspaceLabel ?? null,
            ),
            disclaimer,
          ].join("\n\n"),
        ]);
      } else if (!r.session_bound)
        await enqueueSessionNotice(deps, i, r, 0, {
          card: `Started${where}. Follow progress or approve requests in Opengeni.`,
          lead: `Started${where}. Follow progress or approve requests`,
          ...(r.personal ? { after: disclaimer } : {}),
        });
      await settleTeamsMessage(deps.db, i, r, inbound.event_id, null, turnId);
      r.session_bound = true;
      // The chat has now seen this mention and its context: a later mention
      // that continues the chat reads back only to here. Refused mentions
      // stay ordinary context.
      const { conversationId, eventId } = inbound.payload as Record<string, unknown>;
      if (typeof conversationId === "string" && typeof eventId === "string")
        await markTeamsContextMention(deps, i, { conversationId, eventId }).catch(() =>
          deps.observability?.info("Teams authenticated activity outcome", {
            reason: "context_mention_mark_failed",
          }),
        );
    } catch (error) {
      if (error instanceof HTTPException && error.status >= 400 && error.status < 500) {
        const noticeKind =
          error.message === "teams_session_audience_changed" ? "audience_changed" : "admission";
        // An organization agent's asker can't act on Opengeni's workspace
        // pages: they are told the agent isn't available, without a link.
        const noticeText = organizationAgent
          ? teamsOrganizationAgentUnavailableText(
              (await routeAgentLabel())?.name ??
                (inbound.payload as TeamsRoutedPayload).teamsRouting?.agentName ??
                "This agent",
            )
          : admissionNotice(deps, r, noticeKind).text;
        await enqueueTeamsOutput(deps.db, i, r, -1, [noticeText], {
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
  const ownerActor = await routeActor(deps, i, r, r.actor_id);
  if (
    !ownerActor ||
    ownerActor.subjectId !== r.subject_id ||
    !hasPermission(ownerActor.grant.permissions, "sessions:read")
  ) {
    await refuseTeamsRouteOutputs(deps.db, i, r, "teams_owner_access_revoked");
    return;
  }
  const owner = ownerActor.grant;
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
      if (!routeAudienceHolds(r, audience)) {
        await refuseTeamsRouteOutputs(deps.db, i, r, "teams_destination_audience_changed");
        return;
      }
      // Replies say who answered and where: an agent's always (Teams shows
      // one bot name), and a one-off `in <Workspace>: …` message's, which
      // otherwise says nothing about the workspace it went to.
      // What this chat's own messages said about routing, per turn, once per pass.
      const turnRouting = new Map<string, Promise<Record<string, unknown>[]>>();
      const routingOf = (turnId: string) => {
        let pending = turnRouting.get(turnId);
        if (!pending) {
          pending = getTeamsTurnRouting(deps.db, i, r, turnId);
          turnRouting.set(turnId, pending);
        }
        return pending;
      };
      // An organization agent's chat is visible to its workspace, whose
      // members can start turns in it with their own access. Only turns the
      // asker's own Teams messages started are sent to them. This relies on
      // an inbox row being linked to its turn (settleTeamsMessage) before
      // that turn's events are drained: admission and appends settle it
      // earlier in the same pass, so an own turn is never skipped.
      const forThisChat = async (turnId: string | null | undefined) =>
        !organizationAgent || (Boolean(turnId) && (await routingOf(turnId!)).length > 0);
      const replyHeader = async (turnId: string | null) => {
        const agent = await routeAgentLabel();
        if (agent)
          return teamsReplyHeader({ agentName: agent.name, workspaceName: agent.workspaceName });
        if (!turnId) return null;
        const oneOff = (await routingOf(turnId)).find(
          (routing) => routing.oneOff === true && typeof routing.workspaceLabel === "string",
        );
        return oneOff
          ? teamsReplyHeader({ agentName: null, workspaceName: oneOff.workspaceLabel as string })
          : null;
      };
      const page = await scope(() =>
        listSessionEventPage(deps.db, routeSessionWorkspace(r), r.session_id, {
          after: Number(r.delivered_sequence),
          limit: 100,
          maxBytes: 256 * 1024,
        }),
      );
      for (const event of page.events) {
        const payload = event.payload as Record<string, unknown>;
        if (!(await forThisChat(event.turnId))) {
          // Moves the route past another person's turn without sending it.
          await enqueueTeamsOutput(deps.db, i, r, event.sequence, []);
          continue;
        }
        if (event.type === "turn.completed") {
          const reply =
            typeof payload.output === "string" && payload.output.trim()
              ? payload.output
              : turnCompletedReply(payload);
          const header = reply ? await replyHeader(event.turnId ?? null) : null;
          const text = header && reply ? `${header}\n\n${reply}` : reply;
          await enqueueTeamsOutput(
            deps.db,
            i,
            r,
            event.sequence,
            text ? teamsReplyParts(text) : [],
            undefined,
            { turnId: event.turnId ?? null },
          );
          if (event.turnId) await markTeamsTurnAnswered(deps.db, i, r, event.turnId);
          continue;
        }
        const notice =
          event.type === "session.requiresAction" || event.type === "session.humanInput.requested"
            ? {
                card: "Your task needs your input or approval in the secure Opengeni chat.",
                lead: "Your task needs your input or approval. Open the secure Opengeni chat",
                // Nobody approves an organization agent's chat (it runs
                // unattended), and its asker can't open it.
                plain:
                  "This request needs an approval or input that only a member of the agent's workspace can give.",
              }
            : event.type === "turn.failed"
              ? {
                  card: "The task could not finish. The details are in Opengeni.",
                  lead: "The task could not finish. Open Opengeni for details",
                  plain: "The task could not finish.",
                }
              : null;
        // Without a notice this still moves the route past the event.
        if (notice && organizationAgent)
          await enqueueTeamsOutput(deps.db, i, r, event.sequence, [notice.plain]);
        else if (notice) await enqueueSessionNotice(deps, i, r, event.sequence, notice);
        else await enqueueTeamsOutput(deps.db, i, r, event.sequence, []);
        if (notice && event.turnId) await markTeamsTurnAnswered(deps.db, i, r, event.turnId);
      }
    }
    output = await claimTeamsOutput(deps.db, i, r);
  }
  if (!output) return;
  // Recheck both sides immediately before the external side effect.
  const liveActor = await routeActor(deps, i, r, r.actor_id);
  const liveOwner = liveActor?.grant;
  if (
    !(await currentInstallation(deps, i)) ||
    !liveOwner ||
    liveActor?.subjectId !== r.subject_id
  ) {
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
    if (!routeAudienceHolds(r, deliveryAudience) || !(await renewTeamsRoute(deps.db, i, r))) {
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
    const notice =
      Number(output.source_sequence) === -1 && !isTeamsOrganizationAgentRoute(r)
        ? admissionNotice(
            deps,
            r,
            output.payload.notice === "audience_changed" ? "audience_changed" : "admission",
          )
        : null;
    const id = await deliver(
      {
        serviceUrl: r.service_url,
        conversationId: r.conversation_id,
        threadId: r.thread_id,
        botId: r.bot_id,
      },
      notice
        ? notice.text
        : output.payload.link === "session"
          ? (output.payload.cardText ?? output.payload.text)
          : output.payload.text,
      notice
        ? { link: notice.link }
        : output.payload.link === "session"
          ? { link: sessionLink(deps, r) }
          : { ai: output.payload.ai === true },
    );
    await settleTeamsOutput(deps.db, i, output.operation_id, {
      state: "delivered",
      ...(id ? { providerMessageId: id } : {}),
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
  deliver: TeamsSender = async (m, text, options) => send(await runtime(deps), m, text, options),
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
