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
): Promise<{ tenantId: string; personal: boolean; channelId: string | null }> {
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
    const [installation] = await rawRows<{ tenant_id: string }>(
      tx,
      sql`select tenant_id from teams_bot_installations
        where account_id=${input.accountId}::uuid and workspace_id=${input.workspaceId}::uuid
          and active and generation=${input.proof.installationGeneration}::uuid for share`,
    );
    if (!installation) throw new Error("teams_private_session_proof_invalid");
    // Keep the order explicit rather than relying on a join planner's row marks:
    // native session/workspace -> installation -> route -> inbox -> link.
    const [route] = await rawRows<{
      personal: boolean;
      channel_id: string | null;
      actor_id: string;
    }>(
      tx,
      sql`select personal,channel_id,actor_id from teams_bot_routes
        where route_id=${input.proof.routeId} and account_id=${input.accountId}::uuid
          and workspace_id=${input.workspaceId}::uuid and tenant_id=${installation.tenant_id}::uuid
          and generation=${input.proof.installationGeneration}::uuid
          and (${input.personal ?? null}::boolean is null or personal=${input.personal ?? null}::boolean)
          and session_id=${input.sessionId}::uuid
          and (not personal or subject_id=${input.subjectId})
          and lease_token=${input.proof.leaseToken}::uuid and lease_until>clock_timestamp()
        for share`,
    );
    if (!route) throw new Error("teams_private_session_proof_invalid");
    const [event] = await rawRows<{ actor_id: string }>(
      tx,
      sql`
      select actor_id from teams_bot_inbox
      where route_id=${input.proof.routeId} and account_id=${input.accountId}::uuid
        and workspace_id=${input.workspaceId}::uuid and event_id=${input.proof.eventId}
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
        and workspace_id=${input.workspaceId}::uuid and actor_id=${event.actor_id}::uuid
        and subject_id=${input.subjectId} for share`,
    );
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
    };
  });
}

export async function requireTeamsPrivateSessionProof(
  db: Database,
  input: Parameters<typeof requireTeamsConversationProof>[1],
): Promise<string> {
  return (await requireTeamsConversationProof(db, { ...input, personal: true })).tenantId;
}
