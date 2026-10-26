import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

export type TeamsInstallation = {
  tenant_id: string;
  account_id: string;
  workspace_id: string;
  generation: string;
  active: boolean;
};
export type TeamsRoute = TeamsInstallation & {
  route_id: string;
  actor_id: string;
  subject_id: string;
  personal: boolean;
  channel_id: string | null;
  conversation_id: string;
  thread_id: string | null;
  service_url: string;
  bot_id: string;
  session_id: string;
  session_bound: boolean;
  delivered_sequence: number;
  lease_token: string | null;
};
export type TeamsInbox = {
  event_id: string;
  route_id: string;
  actor_id: string;
  subject_id: string;
  payload: Record<string, unknown>;
};
export type TeamsOutbox = {
  source_sequence: number;
  operation_id: string;
  payload: { text: string; notice?: "admission" | "audience_changed" };
  route_id: string;
};
const scope = (i: { account_id: string; workspace_id: string }) => ({
  accountId: i.account_id,
  workspaceId: i.workspace_id,
});
export const teamsScoped = <T>(
  db: Database,
  i: TeamsInstallation,
  fn: (tx: Database) => Promise<T>,
) =>
  withRlsContext(db, scope(i), async (tx) => {
    await tx.execute(
      sql`select id from workspaces where id=${i.workspace_id}::uuid and account_id=${i.account_id}::uuid for key share`,
    );
    return fn(tx);
  });
export async function listTeamsInstallations(
  db: Database,
  afterTenantId: string | null = null,
): Promise<TeamsInstallation[]> {
  return rawRows<TeamsInstallation>(
    db,
    sql`select tenant_id,account_id,workspace_id,generation,active from teams_bot_installations where active and (${afterTenantId}::uuid is null or tenant_id>${afterTenantId}::uuid) order by tenant_id limit 100`,
  );
}
export async function getTeamsInstallation(
  db: Database,
  tenantId: string,
): Promise<TeamsInstallation | null> {
  return (
    (
      await rawRows<TeamsInstallation>(
        db,
        sql`select tenant_id,account_id,workspace_id,generation,active from teams_bot_installations where tenant_id=${tenantId}::uuid limit 1`,
      )
    )[0] ?? null
  );
}
export async function getWorkspaceTeamsInstallation(
  db: Database,
  workspaceId: string,
): Promise<TeamsInstallation | null> {
  return (
    (
      await rawRows<TeamsInstallation>(
        db,
        sql`select tenant_id,account_id,workspace_id,generation,active from teams_bot_installations where workspace_id=${workspaceId}::uuid limit 1`,
      )
    )[0] ?? null
  );
}
export async function installTeamsBot(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    tenantId: string;
    actorId: string;
    subjectId: string;
    nonce: string;
  },
) {
  return withRlsContext(db, input, async (tx) => {
    await tx.execute(
      sql`select id from workspaces where id=${input.workspaceId}::uuid and account_id=${input.accountId}::uuid for key share`,
    );
    await tx.execute(
      sql`insert into teams_bot_proofs(account_id,workspace_id,nonce) values(${input.accountId}::uuid,${input.workspaceId}::uuid,${input.nonce}::uuid)`,
    );
    const rows = await rawRows<TeamsInstallation>(
      tx,
      sql`insert into teams_bot_installations(tenant_id,account_id,workspace_id) values(${input.tenantId}::uuid,${input.accountId}::uuid,${input.workspaceId}::uuid)
    on conflict(tenant_id) do update set active=true,generation=gen_random_uuid() where teams_bot_installations.workspace_id=excluded.workspace_id returning *`,
    );
    if (!rows[0]) throw new Error("teams_tenant_already_bound");
    await tx.execute(
      sql`update teams_bot_inbox set state='failed',error_code='installation_replaced' where state='pending' and route_id in(select route_id from teams_bot_routes where tenant_id=${input.tenantId}::uuid and generation<>${rows[0].generation}::uuid)`,
    );
    await tx.execute(
      sql`update teams_bot_outbox set state=case when state='sending' then 'unknown' else 'failed' end,error_code='installation_replaced' where state in ('pending','sending') and route_id in(select route_id from teams_bot_routes where tenant_id=${input.tenantId}::uuid and generation<>${rows[0].generation}::uuid)`,
    );
    const linked = await rawRows(
      tx,
      sql`insert into teams_bot_links(account_id,workspace_id,tenant_id,actor_id,subject_id) values(${input.accountId}::uuid,${input.workspaceId}::uuid,${input.tenantId}::uuid,${input.actorId}::uuid,${input.subjectId}) on conflict(tenant_id,actor_id) do update set subject_id=excluded.subject_id where teams_bot_links.subject_id=excluded.subject_id returning actor_id`,
    );
    if (!linked.length) throw new Error("teams_identity_already_linked");
    return rows[0];
  });
}
export async function linkTeamsActor(
  db: Database,
  i: TeamsInstallation,
  input: { actorId: string; subjectId: string; nonce: string },
) {
  return teamsScoped(db, i, async (tx) => {
    const active = await rawRows(
      tx,
      sql`select 1 from teams_bot_installations where tenant_id=${i.tenant_id}::uuid and active and generation=${i.generation}::uuid for update`,
    );
    if (!active.length) throw new Error("teams_installation_changed");
    await tx.execute(
      sql`insert into teams_bot_proofs(account_id,workspace_id,nonce) values(${i.account_id}::uuid,${i.workspace_id}::uuid,${input.nonce}::uuid)`,
    );
    const rows = await rawRows(
      tx,
      sql`insert into teams_bot_links(account_id,workspace_id,tenant_id,actor_id,subject_id) values(${i.account_id}::uuid,${i.workspace_id}::uuid,${i.tenant_id}::uuid,${input.actorId}::uuid,${input.subjectId}) on conflict(tenant_id,actor_id) do update set subject_id=excluded.subject_id where teams_bot_links.subject_id=excluded.subject_id returning actor_id`,
    );
    if (!rows.length) throw new Error("teams_identity_already_linked");
  });
}
export async function getTeamsActor(
  db: Database,
  i: TeamsInstallation,
  actorId: string,
): Promise<string | null> {
  return teamsScoped(
    db,
    i,
    async (tx) =>
      (
        await rawRows<{ subject_id: string }>(
          tx,
          sql`select subject_id from teams_bot_links where tenant_id=${i.tenant_id}::uuid and actor_id=${actorId}::uuid`,
        )
      )[0]?.subject_id ?? null,
  );
}
export async function getOwnTeamsLink(db: Database, i: TeamsInstallation, subjectId: string) {
  return teamsScoped(
    db,
    i,
    async (tx) =>
      (
        await rawRows<{ actor_id: string }>(
          tx,
          sql`select actor_id from teams_bot_links where tenant_id=${i.tenant_id}::uuid and subject_id=${subjectId}`,
        )
      )[0] ?? null,
  );
}
export async function removeTeamsLink(db: Database, i: TeamsInstallation, subjectId: string) {
  return teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`select 1 from teams_bot_installations where tenant_id=${i.tenant_id}::uuid for update`,
    );
    const [link] = await rawRows<{ actor_id: string }>(
      tx,
      sql`select actor_id from teams_bot_links where tenant_id=${i.tenant_id}::uuid and subject_id=${subjectId}`,
    );
    if (!link) return;
    await tx.execute(
      sql`select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and (actor_id=${link.actor_id}::uuid or exists(select 1 from teams_bot_inbox inbox where inbox.route_id=teams_bot_routes.route_id and inbox.actor_id=${link.actor_id}::uuid and inbox.state='pending')) order by route_id for update`,
    );
    await tx.execute(
      sql`update teams_bot_inbox set state='failed',error_code='actor_unlinked' where workspace_id=${i.workspace_id}::uuid and actor_id=${link.actor_id}::uuid and state='pending'`,
    );
    await tx.execute(
      sql`update teams_bot_outbox set state=case when state='sending' then 'unknown' else 'failed' end,error_code='actor_unlinked' where state in ('pending','sending') and route_id in(select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and actor_id=${link.actor_id}::uuid)`,
    );
    await tx.execute(
      sql`update teams_bot_routes set delivered_sequence=greatest(delivered_sequence,relevant_event_sequence) where tenant_id=${i.tenant_id}::uuid and actor_id=${link.actor_id}::uuid`,
    );
    await tx.execute(
      sql`delete from teams_bot_links where tenant_id=${i.tenant_id}::uuid and actor_id=${link.actor_id}::uuid and subject_id=${subjectId}`,
    );
  });
}
export async function disconnectTeamsBot(db: Database, i: TeamsInstallation) {
  return teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`update teams_bot_installations set active=false,generation=gen_random_uuid() where tenant_id=${i.tenant_id}::uuid`,
    );
    await tx.execute(
      sql`update teams_bot_inbox set state='failed',error_code='installation_disconnected' where workspace_id=${i.workspace_id}::uuid and state='pending'`,
    );
    await tx.execute(
      sql`update teams_bot_outbox set state=case when state='sending' then 'unknown' else 'failed' end,error_code='installation_disconnected' where workspace_id=${i.workspace_id}::uuid and state in ('pending','sending')`,
    );
  });
}
export async function enqueueTeamsMessage(
  db: Database,
  i: TeamsInstallation,
  input: {
    routeId: string;
    actorId: string;
    subjectId: string;
    personal: boolean;
    channelId?: string | null;
    conversationId: string;
    threadId: string | null;
    serviceUrl: string;
    botId: string;
    eventId: string;
    payload: unknown;
  },
) {
  return teamsScoped(db, i, async (tx) => {
    const active = await rawRows(
      tx,
      sql`select 1 from teams_bot_installations where tenant_id=${i.tenant_id}::uuid and active and generation=${i.generation}::uuid for share`,
    );
    if (!active.length) throw new Error("teams_installation_changed");
    await tx.execute(sql`insert into teams_bot_routes(account_id,workspace_id,tenant_id,route_id,generation,actor_id,subject_id,personal,channel_id,conversation_id,thread_id,service_url,bot_id)
   values(${i.account_id}::uuid,${i.workspace_id}::uuid,${i.tenant_id}::uuid,${input.routeId},${i.generation}::uuid,${input.actorId}::uuid,${input.subjectId},${input.personal},${input.channelId ?? null},${input.conversationId},${input.threadId},${input.serviceUrl},${input.botId}) on conflict(route_id) do nothing`);
    const [route] = await rawRows<TeamsRoute>(
      tx,
      sql`select * from teams_bot_routes where route_id=${input.routeId}`,
    );
    if (
      !route ||
      route.generation !== i.generation ||
      (route.personal && route.actor_id !== input.actorId)
    )
      throw new Error("teams_route_unavailable");
    await tx.execute(
      sql`insert into teams_bot_inbox(account_id,workspace_id,event_id,route_id,actor_id,subject_id,payload) values(${i.account_id}::uuid,${i.workspace_id}::uuid,${input.eventId},${input.routeId},${input.actorId}::uuid,${input.subjectId},${JSON.stringify(input.payload)}::jsonb) on conflict(event_id) do nothing`,
    );
  });
}
export async function claimTeamsRoute(
  db: Database,
  i: TeamsInstallation,
): Promise<TeamsRoute | null> {
  return teamsScoped(db, i, async (tx) => {
    const token = randomUUID();
    return (
      (
        await rawRows<TeamsRoute>(
          tx,
          sql`update teams_bot_routes set lease_token=${token}::uuid,lease_until=now()+interval '2 minutes',last_claimed_at=clock_timestamp() where route_id=(select route_id from teams_bot_routes where tenant_id=${i.tenant_id}::uuid and generation=${i.generation}::uuid and (lease_until is null or lease_until<now()) and (
 relevant_event_sequence>delivered_sequence
 or exists(select 1 from teams_bot_inbox inbox where inbox.route_id=teams_bot_routes.route_id and inbox.state='pending')
 or exists(select 1 from teams_bot_outbox outbox where outbox.route_id=teams_bot_routes.route_id and outbox.state='sending')
 or (select outbox.retry_at<=now() from teams_bot_outbox outbox where outbox.route_id=teams_bot_routes.route_id and outbox.state='pending' order by source_sequence,part_index limit 1)
 ) order by last_claimed_at nulls first,route_id for update skip locked limit 1) returning *`,
        )
      )[0] ?? null
    );
  });
}
export async function releaseTeamsRoute(db: Database, i: TeamsInstallation, r: TeamsRoute) {
  await teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`update teams_bot_routes set lease_until=now()+interval '2 seconds',lease_token=null where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid`,
    );
  });
}
export async function getTeamsPendingMessage(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
): Promise<TeamsInbox | null> {
  return teamsScoped(
    db,
    i,
    async (tx) =>
      (
        await rawRows<TeamsInbox>(
          tx,
          sql`select * from teams_bot_inbox where route_id=${r.route_id} and state='pending' order by created_at,event_id limit 1`,
        )
      )[0] ?? null,
  );
}
export async function settleTeamsMessage(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
  eventId: string,
  error: string | null,
) {
  await teamsScoped(db, i, async (tx) => {
    const owned = await rawRows(
      tx,
      sql`select 1 from teams_bot_routes where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid for update`,
    );
    if (!owned.length) return;
    await tx.execute(
      sql`update teams_bot_inbox set state=${error ? "failed" : "accepted"},error_code=${error} where event_id=${eventId}`,
    );
    if (!error)
      await tx.execute(
        sql`update teams_bot_routes set session_bound=true where route_id=${r.route_id}`,
      );
  });
}
export async function enqueueTeamsOutput(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
  sequence: number,
  parts: string[],
  notice?: { eventId: string; kind: "admission" | "audience_changed" },
) {
  await teamsScoped(db, i, async (tx) => {
    const owned = await rawRows(
      tx,
      sql`select 1 from teams_bot_routes where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid for update`,
    );
    if (!owned.length) return;
    for (const [index, text] of parts.entries())
      await tx.execute(
        sql`insert into teams_bot_outbox(account_id,workspace_id,operation_id,route_id,source_sequence,part_index,payload) values(${i.account_id}::uuid,${i.workspace_id}::uuid,${`${r.route_id}:${notice ? `notice:${notice.eventId}` : sequence}:${index}`},${r.route_id},${sequence},${index},${JSON.stringify({ text, ...(notice ? { notice: notice.kind } : {}) })}::jsonb) on conflict(operation_id) do nothing`,
      );
    await tx.execute(
      sql`update teams_bot_routes set delivered_sequence=greatest(delivered_sequence,${sequence}) where route_id=${r.route_id}`,
    );
  });
}
export async function claimTeamsOutput(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
  noticesOnly = false,
): Promise<TeamsOutbox | null> {
  return teamsScoped(db, i, async (tx) => {
    const owned = await rawRows(
      tx,
      sql`select 1 from teams_bot_routes where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid and lease_until>now() for update`,
    );
    if (!owned.length) return null;
    // A previous sender that lost its lease has an unknown provider outcome.
    // Do not blindly repeat it, even after restart.
    await tx.execute(
      sql`update teams_bot_outbox set state='unknown',error_code='sender_interrupted' where route_id=${r.route_id} and state='sending'`,
    );
    return (
      (
        await rawRows<TeamsOutbox>(
          tx,
          sql`update teams_bot_outbox set state='sending' where operation_id=(select operation_id from teams_bot_outbox where route_id=${r.route_id} and state='pending' and (${noticesOnly}=false or source_sequence=-1) order by source_sequence,created_at,part_index,operation_id for update skip locked limit 1) and retry_at<=now() returning *`,
        )
      )[0] ?? null
    );
  });
}
export async function settleTeamsOutput(
  db: Database,
  i: TeamsInstallation,
  operationId: string,
  result: {
    state: "delivered" | "unknown" | "failed" | "pending";
    providerMessageId?: string;
    error?: string;
    retryMs?: number;
  },
) {
  await teamsScoped(db, i, async (tx) => {
    await tx.execute(
      sql`update teams_bot_outbox set state=${result.state},provider_message_id=${result.providerMessageId ?? null},error_code=${result.error ?? null},retry_at=now()+(${result.retryMs ?? 0}*interval '1 millisecond') where operation_id=${operationId} and state='sending'`,
    );
  });
}

export async function renewTeamsRoute(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
): Promise<boolean> {
  return teamsScoped(
    db,
    i,
    async (tx) =>
      (
        await rawRows(
          tx,
          sql`update teams_bot_routes set lease_until=now()+interval '2 minutes' where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid and lease_until>now() returning route_id`,
        )
      ).length === 1,
  );
}
export async function teamsDeliveryStatus(db: Database, i: TeamsInstallation, subjectId: string) {
  return teamsScoped(db, i, async (tx) => {
    const [row] = await rawRows<{ pending: number; unknown: number; failed: number }>(
      tx,
      sql`select count(*) filter(where state in ('pending','sending'))::integer as pending,count(*) filter(where state='unknown')::integer as unknown,count(*) filter(where state='failed')::integer as failed from teams_bot_outbox where route_id in(select route_id from teams_bot_routes where subject_id=${subjectId})`,
    );
    return row ?? { pending: 0, unknown: 0, failed: 0 };
  });
}

export async function refuseTeamsRouteOutputs(
  db: Database,
  i: TeamsInstallation,
  r: TeamsRoute,
  error: string,
) {
  await teamsScoped(db, i, async (tx) => {
    const owned = await rawRows(
      tx,
      sql`select 1 from teams_bot_routes where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid and lease_until>clock_timestamp() for update`,
    );
    if (!owned.length) return;

    await tx.execute(
      sql`update teams_bot_outbox set state='failed',error_code=${error} where route_id=${r.route_id} and state='pending' and exists(select 1 from teams_bot_routes where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid and lease_until>now())`,
    );
    await tx.execute(
      sql`update teams_bot_routes set delivered_sequence=greatest(delivered_sequence,relevant_event_sequence) where route_id=${r.route_id} and lease_token=${r.lease_token}::uuid and lease_until>now()`,
    );
  });
}
