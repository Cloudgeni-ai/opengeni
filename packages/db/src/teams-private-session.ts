import type { TeamsGroupAudience } from "./teams-conversations";
import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

/** A reference to accepted, authenticated Teams ingress, never a public request claim. */
export type TeamsConversationProof = {
  routeId: string;
  eventId: string;
  leaseToken: string;
  installationGeneration: string;
};

/** Verify the durable sender rather than trusting a human-shaped access grant.
 * On a create transaction the share locks fence disconnect, unlink and lease
 * replacement through commit. The API cannot turn an arbitrary conversation or
 * event into private-session authority by copying these identifiers.
 */
export async function requireTeamsConversationProof(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    sessionId: string;
    initialMessage: string;
    personal?: boolean;
    proof: TeamsConversationProof;
  },
): Promise<{
  tenantId: string;
  personal: boolean;
  channelId: string | null;
  conversationId: string;
  groupAudience: TeamsGroupAudience | null;
  /** The installation's workspace; differs from the session's only for a
   * 1:1 route whose session lives in the sender's Personal workspace. */
  installationWorkspaceId: string;
}> {
  return withRlsContext(db, input, async (tx) => {
    // The native admission transaction already owns the canonical workspace
    // prefix. Standalone preflight takes the same prefix before provider rows.
    const workspace = await rawRows(
      tx,
      sql`
      select id from workspaces where id=${input.workspaceId}::uuid
        and account_id=${input.accountId}::uuid for key share`,
    );
    if (!workspace.length) throw new Error("teams_private_session_proof_invalid");
    // A 1:1 route whose session lives in this (Personal) workspace is visible
    // here too; its installation, inbox and link stay in the installation's
    // workspace, so verify those in that scope.
    const [target] = await rawRows<{ workspace_id: string }>(
      tx,
      sql`select workspace_id from teams_bot_routes
        where route_id=${input.proof.routeId} and account_id=${input.accountId}::uuid
          and session_workspace_id=${input.workspaceId}::uuid and personal`,
    );
    if (!target) return await verifyTeamsConversation(tx, input, input.workspaceId);
    return await withRlsContext(
      tx,
      { accountId: input.accountId, workspaceId: target.workspace_id },
      async (scoped) => {
        const installationWorkspace = await rawRows(
          scoped,
          sql`select id from workspaces where id=${target.workspace_id}::uuid
            and account_id=${input.accountId}::uuid for key share`,
        );
        if (!installationWorkspace.length) throw new Error("teams_private_session_proof_invalid");
        return await verifyTeamsConversation(scoped, input, target.workspace_id);
      },
      undefined,
      "none",
    );
  });
}

async function verifyTeamsConversation(
  tx: Database,
  input: Parameters<typeof requireTeamsConversationProof>[1],
  installationWorkspaceId: string,
): Promise<Awaited<ReturnType<typeof requireTeamsConversationProof>>> {
  const [installation] = await rawRows<{ tenant_id: string }>(
    tx,
    sql`select tenant_id from teams_bot_installations
        where account_id=${input.accountId}::uuid and workspace_id=${installationWorkspaceId}::uuid
          and active and generation=${input.proof.installationGeneration}::uuid for share`,
  );
  if (!installation) throw new Error("teams_private_session_proof_invalid");
  // Keep the order explicit rather than relying on a join planner's row marks:
  // native session/workspace -> installation -> route -> inbox -> link.
  const [route] = await rawRows<{
    personal: boolean;
    conversation_id: string;
    group_audience: TeamsGroupAudience | null;
    group_active: boolean;
    channel_id: string | null;
    actor_id: string;
  }>(
    tx,
    sql`select personal,channel_id,actor_id,conversation_id,group_audience,group_active from teams_bot_routes
        where route_id=${input.proof.routeId} and account_id=${input.accountId}::uuid
          and workspace_id=${installationWorkspaceId}::uuid and tenant_id=${installation.tenant_id}::uuid
          and coalesce(session_workspace_id,workspace_id)=${input.workspaceId}::uuid
          and generation=${input.proof.installationGeneration}::uuid
          and (${input.personal ?? null}::boolean is null or personal=${input.personal ?? null}::boolean)
          and session_id=${input.sessionId}::uuid
          and (not personal or subject_id=${input.subjectId})
          and lease_token=${input.proof.leaseToken}::uuid and lease_until>clock_timestamp()
        for share`,
  );
  if (!route || (route.group_audience && !route.group_active))
    throw new Error("teams_private_session_proof_invalid");
  const [event] = await rawRows<{ actor_id: string }>(
    tx,
    sql`
      select actor_id from teams_bot_inbox
      where route_id=${input.proof.routeId} and account_id=${input.accountId}::uuid
        and workspace_id=${installationWorkspaceId}::uuid and event_id=${input.proof.eventId}
        and subject_id=${input.subjectId} and state='pending'
        and payload->>'text'=${input.initialMessage} for share`,
  );
  if (!event || (route.personal && route.actor_id !== event.actor_id)) {
    throw new Error("teams_private_session_proof_invalid");
  }
  const links = await rawRows(
    tx,
    sql`select actor_id from teams_bot_links
      where tenant_id=${installation.tenant_id}::uuid and account_id=${input.accountId}::uuid
        and workspace_id=${installationWorkspaceId}::uuid and actor_id=${event.actor_id}::uuid
        and subject_id=${input.subjectId} for share`,
  );
  if (route.group_audience) {
    if (
      !route.group_audience.some(
        (x) => x.actorId === event.actor_id && x.subjectId === input.subjectId,
      )
    )
      throw new Error("teams_private_session_proof_invalid");
    for (const member of route.group_audience) {
      const matched = await rawRows(
        tx,
        sql`select actor_id from teams_bot_links where tenant_id=${installation.tenant_id}::uuid and actor_id=${member.actorId}::uuid and subject_id=${member.subjectId} for share`,
      );
      if (!matched.length) throw new Error("teams_private_session_proof_invalid");
    }
  }
  // A lock wait may outlast the lease; check wall-clock validity again once
  // every mutable authority row is locked.
  const lease = await rawRows(
    tx,
    sql`select route_id from teams_bot_routes
      where route_id=${input.proof.routeId} and lease_until>clock_timestamp()`,
  );
  if (!links.length || !lease.length) throw new Error("teams_private_session_proof_invalid");
  return {
    tenantId: installation.tenant_id,
    personal: route.personal,
    channelId: route.channel_id,
    conversationId: route.conversation_id,
    groupAudience: route.group_audience,
    installationWorkspaceId,
  };
}

export async function requireTeamsPrivateSessionProof(
  db: Database,
  input: Parameters<typeof requireTeamsConversationProof>[1],
): Promise<string> {
  return (await requireTeamsConversationProof(db, { ...input, personal: true })).tenantId;
}
