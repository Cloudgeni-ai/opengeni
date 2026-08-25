/**
 * Per-channel and per-DM Slack workspace routing reads and writes.
 *
 * Two tenancy scopes, not one relocated workspace:
 *
 * - **HOME** is the installation binding's `(accountId, workspaceId)`. It owns
 *   the `connections` row and bot credential, the bot post/update/delete
 *   ledgers, `slack_interaction_inbox`, `slack_bot_user_links`, App Home
 *   refreshes, reaction-summon settings, Slack task policy, and every table in
 *   this module. The bot client is ALWAYS built from HOME.
 * - **TARGET** is the routed `(accountId, workspaceId)`. It owns the
 *   `slack_interactions` row, its action handles, its progress deliveries, the
 *   grant, the session, and every session event.
 *
 * Both sides always sit in one organization: `target_account_id = account_id`
 * is a table CHECK.
 *
 * `resolveSlackTargetAuthority` - the only place a Slack request may reach a
 * managed human's personal workspace - deliberately lives in `./index`
 * alongside `getWorkspaceGrant`, `managedPersonalWorkspacePermissions`, and
 * `namedSubjectHasLiveWorkspaceAuthority`, because no sibling module in this
 * package imports `./index` and this one must not be the first.
 */
import { and, eq, sql } from "drizzle-orm";

import { rawRows, withRlsContext, type Database } from "./database";
import { namedSubjectPersonalWorkspaceId } from "./slack-routing-personal-workspace";
import * as schema from "./schema";
import { workspaceMembershipPermissionsAllowSlackLink } from "./slack-user-link-access";

/** The installation binding's own tenancy: credential, identity, and inbox. */
export type SlackRouteHome = { accountId: string; workspaceId: string };

/** How a stored route was decided. `picker` is a human answering the Slack card. */
export type SlackRouteSource = "picker" | "admin";

export type SlackChannelRoute = {
  id: string;
  accountId: string;
  workspaceId: string;
  connectionId: string;
  slackTeamId: string;
  slackChannelId: string;
  targetAccountId: string;
  targetWorkspaceId: string;
  decidedBySubjectId: string;
  decidedBySlackUserId: string;
  source: SlackRouteSource;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type SlackUserDmRoute = Omit<SlackChannelRoute, "slackChannelId"> & {
  slackUserId: string;
};

export type UpsertSlackChannelRouteInput = {
  connectionId: string;
  slackTeamId: string;
  slackChannelId: string;
  targetAccountId: string;
  targetWorkspaceId: string;
  decidedBySubjectId: string;
  decidedBySlackUserId: string;
  source: SlackRouteSource;
};

export type UpsertSlackUserDmRouteInput = Omit<UpsertSlackChannelRouteInput, "slackChannelId"> & {
  slackUserId: string;
};

/** Ids only. Never content, never a subject. */
export type SlackInteractionTenancy = {
  accountId: string;
  workspaceId: string;
  interactionId: string;
};

/** One workspace a Slack-linked subject may start work in. */
export type SlackRoutableWorkspace = {
  accountId: string;
  workspaceId: string;
  label: string;
  /** True for the subject's own personal workspace, which has no membership row. */
  personal: boolean;
};

function mapChannelRoute(row: typeof schema.slackChannelRoutes.$inferSelect): SlackChannelRoute {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    connectionId: row.connectionId,
    slackTeamId: row.slackTeamId,
    slackChannelId: row.slackChannelId,
    targetAccountId: row.targetAccountId,
    targetWorkspaceId: row.targetWorkspaceId,
    decidedBySubjectId: row.decidedBySubjectId,
    decidedBySlackUserId: row.decidedBySlackUserId,
    source: row.source,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapUserDmRoute(row: typeof schema.slackUserDmRoutes.$inferSelect): SlackUserDmRoute {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    connectionId: row.connectionId,
    slackTeamId: row.slackTeamId,
    slackUserId: row.slackUserId,
    targetAccountId: row.targetAccountId,
    targetWorkspaceId: row.targetWorkspaceId,
    decidedBySubjectId: row.decidedBySubjectId,
    decidedBySlackUserId: row.decidedBySlackUserId,
    source: row.source,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Resolve which tenancy owns the `slack_interactions` row for one exact
 * connection-scoped route key, through the content-free SECURITY DEFINER probe.
 *
 * Thread continuation must cross workspaces: `slack_interactions_route_uq` is
 * `(connection_id, route_key)` and therefore connection-global, while every
 * ordinary interaction read is workspace-fenced and would miss a thread whose
 * interaction lives in a routed workspace.
 *
 * This returns IDS ONLY. It cannot widen visibility, because the caller must
 * re-read the full row under the returned tenancy's own RLS - which is what
 * `getSlackInteractionById` already does.
 */
export async function probeSlackInteractionTenancy(
  db: Database,
  input: { accountId: string; connectionId: string; routeKey: string },
): Promise<SlackInteractionTenancy | null> {
  const rows = await rawRows<{
    account_id: string;
    workspace_id: string;
    interaction_id: string;
  }>(
    db,
    sql`select account_id, workspace_id, interaction_id
      from opengeni_private.resolve_slack_interaction_tenancy(
        ${input.accountId}::uuid,
        ${input.connectionId}::uuid,
        ${input.routeKey}
      )`,
  );
  const row = rows[0];
  return row
    ? {
        accountId: row.account_id,
        workspaceId: row.workspace_id,
        interactionId: row.interaction_id,
      }
    : null;
}

/**
 * Which workspace owns one Slack action handle.
 *
 * A button click arrives on an inbox row that carries the installation's
 * tenancy and names the handle only by id, while the handle lives in the
 * workspace that owns its session. Content-free, ids only: the caller must
 * re-read the full handle under the returned tenancy's own RLS, where every
 * existing authorization check already lives.
 */
export async function probeSlackActionHandleTenancy(
  db: Database,
  input: { accountId: string; connectionId: string; handleId: string },
): Promise<SlackRouteHome | null> {
  const rows = await rawRows<{ account_id: string; workspace_id: string }>(
    db,
    sql`select account_id, workspace_id
      from opengeni_private.resolve_slack_action_handle_tenancy(
        ${input.accountId}::uuid,
        ${input.connectionId}::uuid,
        ${input.handleId}::uuid
      )`,
  );
  const row = rows[0];
  return row ? { accountId: row.account_id, workspaceId: row.workspace_id } : null;
}

export async function getSlackChannelRoute(
  db: Database,
  home: SlackRouteHome,
  input: { connectionId: string; slackChannelId: string },
): Promise<SlackChannelRoute | null> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.slackChannelRoutes)
      .where(
        and(
          eq(schema.slackChannelRoutes.accountId, home.accountId),
          eq(schema.slackChannelRoutes.workspaceId, home.workspaceId),
          eq(schema.slackChannelRoutes.connectionId, input.connectionId),
          eq(schema.slackChannelRoutes.slackChannelId, input.slackChannelId),
        ),
      )
      .limit(1);
    return row ? mapChannelRoute(row) : null;
  });
}

export async function getSlackUserDmRoute(
  db: Database,
  home: SlackRouteHome,
  input: { connectionId: string; slackUserId: string },
): Promise<SlackUserDmRoute | null> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.slackUserDmRoutes)
      .where(
        and(
          eq(schema.slackUserDmRoutes.accountId, home.accountId),
          eq(schema.slackUserDmRoutes.workspaceId, home.workspaceId),
          eq(schema.slackUserDmRoutes.connectionId, input.connectionId),
          eq(schema.slackUserDmRoutes.slackUserId, input.slackUserId),
        ),
      )
      .limit(1);
    return row ? mapUserDmRoute(row) : null;
  });
}

/**
 * The ask-once memory for a channel. A repeat write for the same
 * `(connectionId, slackChannelId)` re-points the channel and bumps `version`;
 * it never creates a second row, so a channel always has exactly one answer.
 *
 * The caller is responsible for having authorized `target*` for the deciding
 * subject through `resolveSlackTargetAuthority` first - a stored route is
 * memory, never authority, and every later use re-authorizes it live.
 */
export async function upsertSlackChannelRoute(
  db: Database,
  home: SlackRouteHome,
  input: UpsertSlackChannelRouteInput,
): Promise<SlackChannelRoute> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .insert(schema.slackChannelRoutes)
      .values({
        accountId: home.accountId,
        workspaceId: home.workspaceId,
        connectionId: input.connectionId,
        slackTeamId: input.slackTeamId,
        slackChannelId: input.slackChannelId,
        targetAccountId: input.targetAccountId,
        targetWorkspaceId: input.targetWorkspaceId,
        decidedBySubjectId: input.decidedBySubjectId,
        decidedBySlackUserId: input.decidedBySlackUserId,
        source: input.source,
      })
      .onConflictDoUpdate({
        target: [schema.slackChannelRoutes.connectionId, schema.slackChannelRoutes.slackChannelId],
        set: {
          slackTeamId: input.slackTeamId,
          targetAccountId: input.targetAccountId,
          targetWorkspaceId: input.targetWorkspaceId,
          decidedBySubjectId: input.decidedBySubjectId,
          decidedBySlackUserId: input.decidedBySlackUserId,
          source: input.source,
          version: sql`${schema.slackChannelRoutes.version} + 1`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    if (!row) throw new Error("Slack channel route write returned no row");
    return mapChannelRoute(row);
  });
}

/** The ask-once memory for one Slack human's direct messages. */
export async function upsertSlackUserDmRoute(
  db: Database,
  home: SlackRouteHome,
  input: UpsertSlackUserDmRouteInput,
): Promise<SlackUserDmRoute> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .insert(schema.slackUserDmRoutes)
      .values({
        accountId: home.accountId,
        workspaceId: home.workspaceId,
        connectionId: input.connectionId,
        slackTeamId: input.slackTeamId,
        slackUserId: input.slackUserId,
        targetAccountId: input.targetAccountId,
        targetWorkspaceId: input.targetWorkspaceId,
        decidedBySubjectId: input.decidedBySubjectId,
        decidedBySlackUserId: input.decidedBySlackUserId,
        source: input.source,
      })
      .onConflictDoUpdate({
        target: [schema.slackUserDmRoutes.connectionId, schema.slackUserDmRoutes.slackUserId],
        set: {
          slackTeamId: input.slackTeamId,
          targetAccountId: input.targetAccountId,
          targetWorkspaceId: input.targetWorkspaceId,
          decidedBySubjectId: input.decidedBySubjectId,
          decidedBySlackUserId: input.decidedBySlackUserId,
          source: input.source,
          version: sql`${schema.slackUserDmRoutes.version} + 1`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    if (!row) throw new Error("Slack DM route write returned no row");
    return mapUserDmRoute(row);
  });
}

/** Clear a channel's stored answer; the next message asks again. */
export async function deleteSlackChannelRoute(
  db: Database,
  home: SlackRouteHome,
  input: { connectionId: string; slackChannelId: string },
): Promise<boolean> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const removed = await scopedDb
      .delete(schema.slackChannelRoutes)
      .where(
        and(
          eq(schema.slackChannelRoutes.accountId, home.accountId),
          eq(schema.slackChannelRoutes.workspaceId, home.workspaceId),
          eq(schema.slackChannelRoutes.connectionId, input.connectionId),
          eq(schema.slackChannelRoutes.slackChannelId, input.slackChannelId),
        ),
      )
      .returning({ id: schema.slackChannelRoutes.id });
    return removed.length > 0;
  });
}

/** Clear one Slack human's stored DM answer; DMs fall back to the derived personal workspace. */
export async function deleteSlackUserDmRoute(
  db: Database,
  home: SlackRouteHome,
  input: { connectionId: string; slackUserId: string },
): Promise<boolean> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const removed = await scopedDb
      .delete(schema.slackUserDmRoutes)
      .where(
        and(
          eq(schema.slackUserDmRoutes.accountId, home.accountId),
          eq(schema.slackUserDmRoutes.workspaceId, home.workspaceId),
          eq(schema.slackUserDmRoutes.connectionId, input.connectionId),
          eq(schema.slackUserDmRoutes.slackUserId, input.slackUserId),
        ),
      )
      .returning({ id: schema.slackUserDmRoutes.id });
    return removed.length > 0;
  });
}

/**
 * THE workspaces one subject may start Slack work in, within one organization.
 *
 * This is deliberately one function so the "workspaces this subject may create
 * sessions in" question has a single implementation that a future shared
 * candidate-set contract can replace wholesale, rather than several call sites
 * each re-deriving it slightly differently.
 *
 * Two independent sources, unioned:
 *
 * 1. `workspace_memberships` joined to `workspaces` in this account, filtered
 *    to memberships that actually permit starting work (`sessions:create`, or
 *    `workspace:admin` which implies it).
 * 2. The subject's OWN personal workspace, from the active organization
 *    membership's `personalWorkspaceId` pointer.
 *
 * `listWorkspacesForSubject` is NOT usable here: it is a bare membership join
 * with no permission filter, and it cannot see personal workspaces at all,
 * because a managed human's personal workspace deliberately has no
 * `workspace_memberships` row.
 *
 * The personal-workspace id is DERIVED from the membership pointer. It is never
 * accepted from a Slack payload, a route row, or a caller argument.
 *
 * Ordered stably by label then workspace id, with plain code-unit comparison so
 * two hosts with different ICU data cannot render a picker differently.
 *
 * ORACLE, NOT AN AUTHORIZATION. This answers "what could this named subject use"
 * for whatever subject it is handed; it does not establish that the caller IS
 * that subject. Pass only a subject authenticated out of band - for Slack, one
 * named by a durable `slack_bot_user_links` row. Never pass a subject taken
 * from a request payload.
 */
export async function listNamedSubjectSlackRoutableWorkspaces(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<SlackRoutableWorkspace[]> {
  const membershipRows = await db
    .select({
      workspaceId: schema.workspaces.id,
      accountId: schema.workspaces.accountId,
      name: schema.workspaces.name,
      permissions: schema.workspaceMemberships.permissions,
    })
    .from(schema.workspaceMemberships)
    .innerJoin(schema.workspaces, eq(schema.workspaceMemberships.workspaceId, schema.workspaces.id))
    .where(
      and(
        eq(schema.workspaceMemberships.subjectId, input.subjectId),
        eq(schema.workspaces.accountId, input.accountId),
      ),
    );

  const candidates = new Map<string, SlackRoutableWorkspace>();
  for (const row of membershipRows) {
    if (!workspaceMembershipPermissionsAllowSlackLink(row.permissions)) continue;
    candidates.set(row.workspaceId, {
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      label: row.name,
      personal: false,
    });
  }

  const personalWorkspaceId = await namedSubjectPersonalWorkspaceId(db, input);
  if (personalWorkspaceId) {
    const [row] = await db
      .select({
        id: schema.workspaces.id,
        accountId: schema.workspaces.accountId,
        name: schema.workspaces.name,
      })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, personalWorkspaceId),
          eq(schema.workspaces.accountId, input.accountId),
        ),
      )
      .limit(1);
    if (row) {
      candidates.set(row.id, {
        accountId: row.accountId,
        workspaceId: row.id,
        label: row.name,
        personal: true,
      });
    }
  }

  return [...candidates.values()].sort(
    (left, right) =>
      compareCodeUnits(left.label, right.label) ||
      compareCodeUnits(left.workspaceId, right.workspaceId),
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
