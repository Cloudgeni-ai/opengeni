import {
  MCP_OAUTH_SCOPE,
  McpAutoConnectRefusalReason,
  OrganizationAccessPolicy,
  type McpTrustedIssuerProvider,
  type McpTrustedIssuerStatus,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { assertActiveManagedHumanOrganizationMembership } from "./organization-membership-lifecycle";
import {
  withOrganizationAdministrator,
  type AuthorizeOrganizationConnectorAdministration,
} from "./organization-connectors";
import { nestedPostgresSqlState } from "./persistence-errors";

/* ----------------------------------------------------------------------------
   MCP auto-connect, inbound (packages/db/drizzle/1239_mcp_auto_connect.sql).

   An organization trusts an identity issuer: Claude's per-organization
   issuer, or its own identity provider. When an MCP client redeems an ID-JAG
   that issuer signed, the person it names is matched to an active member and
   connected to the organization MCP server with the issuer's access setting.
   No sign-in screen, and no refresh token: the client redeems a new ID-JAG
   when its access token expires.

   An auto-connected agent is one connection (a refresh-token family), keyed
   by issuer, the issuer's subject and the client. Its anchor row carries a
   refresh token nobody holds; every redemption extends it and adds an access
   token to the family, so connected agents list, change and disconnect it
   exactly like a signed-in one. The issuer's access setting is the
   connection's: changing it changes every connection it made, and removing
   or turning off the issuer disconnects them.
   -------------------------------------------------------------------------- */

/** Recent attempts kept per issuer, for setup troubleshooting. */
const EVENTS_KEPT_PER_ISSUER = 200;

export type McpTrustedIssuerRecord = {
  id: string;
  accountId: string;
  name: string;
  provider: McpTrustedIssuerProvider;
  issuer: string;
  jwksUri: string | null;
  allowedClientIds: string[] | null;
  organizationAccess: OrganizationAccessPolicy;
  status: McpTrustedIssuerStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type McpTrustedIssuerSummary = McpTrustedIssuerRecord & {
  connectedPeople: number;
  lastConnectedAt: Date | null;
  lastRefusal: { reason: McpAutoConnectRefusalReason; at: Date } | null;
};

export class McpTrustedIssuerExistsError extends Error {
  readonly name = "McpTrustedIssuerExistsError";
  constructor() {
    super("This organization already trusts that issuer");
  }
}

type TrustedIssuerRow = {
  id: string;
  account_id: string;
  name: string;
  provider: string;
  issuer: string;
  jwks_uri: string | null;
  allowed_client_ids: unknown;
  organization_access: unknown;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
};

const TRUST_COLUMNS = sql`trust.id, trust.account_id, trust.name, trust.provider, trust.issuer,
  trust.jwks_uri, trust.allowed_client_ids, trust.organization_access, trust.status,
  trust.created_at, trust.updated_at`;

/**
 * One issuer's connection lock. Redemptions share it; turning the issuer off,
 * changing its access or removing it takes it alone. So a connection being
 * made either finishes first (and is then revoked or updated with the rest)
 * or waits and reads the change.
 */
function trustedIssuerLockKey(trustedIssuerId: string) {
  return sql`hashtextextended(${`mcp-trusted-issuer:${trustedIssuerId}`}, 0)`;
}

async function lockTrustedIssuerExclusive(tx: Database, trustedIssuerId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${trustedIssuerLockKey(trustedIssuerId)})`);
}

async function lockTrustedIssuerShared(tx: Database, trustedIssuerId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(${trustedIssuerLockKey(trustedIssuerId)})`,
  );
}

/* ------------------------------ Administration ------------------------------ */

export async function listMcpTrustedIssuers(
  db: Database,
  scope: { accountId: string },
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<McpTrustedIssuerSummary[]> {
  return await withOrganizationAdministrator(db, scope.accountId, authorize, async (tx) =>
    listTrustedIssuerSummaries(tx, scope.accountId),
  );
}

export async function createMcpTrustedIssuer(
  db: Database,
  scope: { accountId: string },
  input: {
    name: string;
    provider: McpTrustedIssuerProvider;
    issuer: string;
    jwksUri: string | null;
    allowedClientIds: string[] | null;
    organizationAccess: OrganizationAccessPolicy;
  },
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<McpTrustedIssuerSummary> {
  return await withOrganizationAdministrator(
    db,
    scope.accountId,
    authorize,
    async (tx, subjectId) => {
      const [row] = await rawRows<{ id: string }>(
        tx,
        sql`insert into organization_mcp_trusted_issuers (
          account_id, name, provider, issuer, jwks_uri, allowed_client_ids,
          organization_access, created_by_subject_id, updated_by_subject_id
        ) values (
          ${scope.accountId}::uuid, ${input.name}, ${input.provider}, ${input.issuer},
          ${input.jwksUri}, ${jsonOrNull(input.allowedClientIds)}::jsonb,
          ${JSON.stringify(input.organizationAccess)}::jsonb, ${subjectId}, ${subjectId}
        )
        on conflict (account_id, issuer) do nothing
        returning id`,
      );
      if (!row) throw new McpTrustedIssuerExistsError();
      const [created] = await listTrustedIssuerSummaries(tx, scope.accountId, row.id);
      if (!created) throw new Error("Trusted issuer was not saved");
      return created;
    },
  );
}

/**
 * Null when the issuer is gone. A new access setting applies to every
 * connection the issuer made from their next request; turning it off
 * disconnects them.
 */
export async function updateMcpTrustedIssuer(
  db: Database,
  scope: { accountId: string; trustedIssuerId: string },
  change: {
    name?: string;
    jwksUri?: string | null;
    allowedClientIds?: string[] | null;
    organizationAccess?: OrganizationAccessPolicy;
    status?: McpTrustedIssuerStatus;
  },
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<McpTrustedIssuerSummary | null> {
  return await withOrganizationAdministrator(
    db,
    scope.accountId,
    authorize,
    async (tx, subjectId) => {
      await lockTrustedIssuerExclusive(tx, scope.trustedIssuerId);
      const [row] = await rawRows<{ id: string }>(
        tx,
        sql`update organization_mcp_trusted_issuers set
          name = ${change.name === undefined ? sql`name` : sql`${change.name}`},
          jwks_uri = ${change.jwksUri === undefined ? sql`jwks_uri` : sql`${change.jwksUri}`},
          allowed_client_ids = ${
            change.allowedClientIds === undefined
              ? sql`allowed_client_ids`
              : sql`${jsonOrNull(change.allowedClientIds)}::jsonb`
          },
          organization_access = ${
            change.organizationAccess === undefined
              ? sql`organization_access`
              : sql`${JSON.stringify(change.organizationAccess)}::jsonb`
          },
          status = ${change.status === undefined ? sql`status` : sql`${change.status}`},
          updated_by_subject_id = ${subjectId},
          updated_at = now()
        where account_id = ${scope.accountId}::uuid and id = ${scope.trustedIssuerId}::uuid
        returning id`,
      );
      if (!row) return null;
      if (change.organizationAccess)
        await setTrustedIssuerConnectionAccess(
          tx,
          scope.accountId,
          scope.trustedIssuerId,
          change.organizationAccess,
        );
      if (change.status === "disabled")
        await revokeTrustedIssuerConnections(tx, scope.accountId, scope.trustedIssuerId);
      const [updated] = await listTrustedIssuerSummaries(tx, scope.accountId, row.id);
      return updated ?? null;
    },
  );
}

/** False when already gone. Every connection it made is disconnected first. */
export async function deleteMcpTrustedIssuer(
  db: Database,
  scope: { accountId: string; trustedIssuerId: string },
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<boolean> {
  return await withOrganizationAdministrator(db, scope.accountId, authorize, async (tx) => {
    // Lock first: a connection being made through it finishes, then is revoked.
    await lockTrustedIssuerExclusive(tx, scope.trustedIssuerId);
    await revokeTrustedIssuerConnections(tx, scope.accountId, scope.trustedIssuerId);
    const deleted = await rawRows<{ id: string }>(
      tx,
      sql`delete from organization_mcp_trusted_issuers
        where account_id = ${scope.accountId}::uuid and id = ${scope.trustedIssuerId}::uuid
        returning id`,
    );
    return deleted.length > 0;
  });
}

export type McpTrustedIssuerEventRecord = {
  id: string;
  outcome: "connected" | "refused";
  reason: McpAutoConnectRefusalReason | null;
  subjectId: string | null;
  personName: string | null;
  email: string | null;
  clientName: string | null;
  createdAt: Date;
};

/** Recent attempts, newest first. Null when the issuer is not this organization's. */
export async function listMcpTrustedIssuerEvents(
  db: Database,
  scope: { accountId: string; trustedIssuerId: string; limit?: number },
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<McpTrustedIssuerEventRecord[] | null> {
  const limit = Math.min(Math.max(scope.limit ?? 50, 1), EVENTS_KEPT_PER_ISSUER);
  return await withOrganizationAdministrator(db, scope.accountId, authorize, async (tx) => {
    const [trust] = await rawRows<{ id: string }>(
      tx,
      sql`select id from organization_mcp_trusted_issuers
        where account_id = ${scope.accountId}::uuid and id = ${scope.trustedIssuerId}::uuid`,
    );
    if (!trust) return null;
    const rows = await rawRows<{
      id: string;
      outcome: string;
      reason: string | null;
      subject_id: string | null;
      person_name: string | null;
      email: string | null;
      client_name: string | null;
      created_at: Date | string;
    }>(
      tx,
      sql`select event.id, event.outcome, event.reason, event.subject_id,
          nullif(btrim(person.name), '') as person_name, event.email, event.client_name,
          event.created_at
        from organization_mcp_trusted_issuer_events event
        left join auth_users person on event.subject_id = 'user:' || person.id
        where event.account_id = ${scope.accountId}::uuid
          and event.trusted_issuer_id = ${scope.trustedIssuerId}::uuid
        order by event.created_at desc, event.id
        limit ${limit}`,
    );
    return rows.map((row) => ({
      id: row.id,
      outcome: row.outcome === "connected" ? "connected" : "refused",
      reason: refusalReason(row.reason),
      subjectId: row.subject_id,
      personName: row.person_name,
      email: row.email,
      clientName: row.client_name,
      createdAt: new Date(row.created_at),
    }));
  });
}

/* --------------------------- Redeeming an ID-JAG --------------------------- */

/**
 * The active issuers, in any organization, that trust `issuer`. The token
 * endpoint runs before anyone is known: it names the one issuer an ID-JAG
 * claims and row security shows only the active rows trusting it.
 */
export async function findActiveMcpTrustedIssuers(
  db: Database,
  issuer: string,
): Promise<McpTrustedIssuerRecord[]> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('opengeni.mcp_assertion_issuer', ${issuer}, true)`);
    const rows = await rawRows<TrustedIssuerRow>(
      tx,
      sql`select ${TRUST_COLUMNS}
        from organization_mcp_trusted_issuers trust
        where trust.issuer = ${issuer} and trust.status = 'active'
        order by trust.created_at, trust.id
        limit 50`,
    );
    await tx.execute(sql`select set_config('opengeni.mcp_assertion_issuer', '', true)`);
    return rows.map(mapTrust);
  });
}

export type McpAssertionMatch = { status: "matched"; subjectId: string } | { status: "unmatched" };

/**
 * The active member whose verified Opengeni email the issuer asserted, on
 * every redemption: an issuer's subject is linked to the member it matched
 * for the admin's view, never trusted in place of the email (the issuer may
 * since have said a different or unverified email for it).
 */
export async function matchMcpAssertionMember(
  db: Database,
  input: {
    accountId: string;
    email: string | null;
  },
): Promise<McpAssertionMatch> {
  if (!input.email) return { status: "unmatched" };
  const email = input.email;
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: null },
    async (tx) => {
      const people = await rawRows<{ id: string }>(
        tx,
        sql`select id from auth_users
          where lower(email) = lower(${email}) and email_verified
          order by created_at, id
          limit 2`,
      );
      if (people.length !== 1) return { status: "unmatched" };
      const subjectId = `user:${people[0]!.id}`;
      return (await isActiveMember(tx, input.accountId, subjectId))
        ? { status: "matched", subjectId }
        : { status: "unmatched" };
    },
    undefined,
    "none",
  );
}

export type RedeemMcpAssertionResult =
  | { status: "connected"; connectionId: string; organizationAccess: OrganizationAccessPolicy }
  | { status: "refused"; reason: McpAutoConnectRefusalReason };

/**
 * Redeems one verified ID-JAG for the matched member: records its `jti` so it
 * is never redeemed again, links the issuer's subject to the member, and
 * issues an access token on the agent's connection (created on first use).
 */
export async function redeemMcpAssertion(
  db: Database,
  input: {
    trust: McpTrustedIssuerRecord;
    subjectId: string;
    assertionSubject: string;
    email: string | null;
    jti: string;
    assertionExpiresAt: Date;
    clientId: string;
    clientName: string | null;
    resource: string;
    accessTokenHash: string;
    accessExpiresAt: Date;
    connectionExpiresAt: Date;
  },
): Promise<RedeemMcpAssertionResult> {
  const { trust } = input;
  return await withRlsContext(
    db,
    { accountId: trust.accountId, workspaceId: null },
    async (tx) => {
      await tx.execute(sql`delete from organization_mcp_assertion_replays
        where ctid in (
          select ctid from organization_mcp_assertion_replays
          where account_id = ${trust.accountId}::uuid and expires_at < clock_timestamp()
          limit 100
        )`);
      const [fresh] = await rawRows<{ jti_hash: string }>(
        tx,
        sql`insert into organization_mcp_assertion_replays (
          trusted_issuer_id, account_id, jti_hash, expires_at
        ) values (
          ${trust.id}::uuid, ${trust.accountId}::uuid, ${sha256(input.jti)},
          ${input.assertionExpiresAt.toISOString()}::timestamptz
        )
        on conflict do nothing
        returning jti_hash`,
      );
      if (!fresh) return { status: "refused", reason: "replayed" };
      // The trust may have changed since it was read: hold its lock, then use
      // the live row. Turning it off, changing its access or removing it waits
      // for this connection and then applies to it, or this waits and reads it.
      await lockTrustedIssuerShared(tx, trust.id);
      const [live] = await rawRows<TrustedIssuerRow>(
        tx,
        sql`select ${TRUST_COLUMNS} from organization_mcp_trusted_issuers trust
          where trust.id = ${trust.id}::uuid and trust.account_id = ${trust.accountId}::uuid
            and trust.status = 'active'`,
      );
      if (!live) return { status: "refused", reason: "issuer_disabled" };
      const organizationAccess = mapTrust(live).organizationAccess;
      if (!(await isActiveMember(tx, trust.accountId, input.subjectId)))
        return { status: "refused", reason: "no_matching_member" };
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`mcp-auto-connect:${trust.id}:${input.assertionSubject}:${input.clientId}`}, 0))`,
      );
      await tx.execute(sql`update mcp_oauth_clients
        set expires_at = greatest(expires_at, clock_timestamp() + interval '31 days')
        where client_id = ${input.clientId} and expires_at > clock_timestamp()`);
      const [existing] = await rawRows<{ family_id: string }>(
        tx,
        sql`select family_id from mcp_oauth_refresh_tokens
          where trusted_issuer_id = ${trust.id}::uuid
            and assertion_subject = ${input.assertionSubject}
            and client_id = ${input.clientId}
            and account_id = ${trust.accountId}::uuid
            and subject_id = ${input.subjectId}
            and revoked_at is null
            and expires_at > clock_timestamp()
          order by created_at desc
          limit 1
          for update`,
      );
      const access = JSON.stringify(organizationAccess);
      let familyId: string;
      if (existing) {
        familyId = existing.family_id;
        await tx.execute(sql`update mcp_oauth_refresh_tokens
          set expires_at = greatest(expires_at, ${input.connectionExpiresAt.toISOString()}::timestamptz),
              organization_access = ${access}::jsonb
          where family_id = ${familyId}::uuid and revoked_at is null`);
      } else {
        familyId = randomUUID();
        await tx.execute(sql`insert into mcp_oauth_refresh_tokens (
          token_hash, family_id, generation, client_id, account_id, workspace_id,
          subject_id, resource, permissions, tool_identities, organization_access,
          connected_at, expires_at, trusted_issuer_id, assertion_subject
        ) values (
          ${unusableTokenHash()}, ${familyId}::uuid, 1, ${input.clientId},
          ${trust.accountId}::uuid, null, ${input.subjectId}, ${input.resource},
          '[]'::jsonb, '[]'::jsonb, ${access}::jsonb, clock_timestamp(),
          ${input.connectionExpiresAt.toISOString()}::timestamptz,
          ${trust.id}::uuid, ${input.assertionSubject}
        )`);
      }
      await tx.execute(sql`insert into mcp_oauth_access_tokens (
        token_hash, refresh_family_id, refresh_generation, client_id, account_id,
        workspace_id, subject_id, resource, permissions, tool_identities, organization_access, expires_at
      ) values (
        ${input.accessTokenHash}, ${familyId}::uuid, 1, ${input.clientId},
        ${trust.accountId}::uuid, null, ${input.subjectId}, ${input.resource},
        '[]'::jsonb, '[]'::jsonb, ${access}::jsonb,
        ${input.accessExpiresAt.toISOString()}::timestamptz
      )`);
      await tx.execute(sql`insert into organization_mcp_trusted_issuer_subjects (
        trusted_issuer_id, account_id, assertion_subject, subject_id, email
      ) values (
        ${trust.id}::uuid, ${trust.accountId}::uuid, ${input.assertionSubject},
        ${input.subjectId}, ${boundedEmail(input.email)}
      )
      on conflict (trusted_issuer_id, assertion_subject) do update
        set subject_id = excluded.subject_id,
            email = coalesce(excluded.email, organization_mcp_trusted_issuer_subjects.email),
            last_connected_at = now()`);
      // One event per new connection, not one per token: a connected agent
      // redeems a new ID-JAG every few minutes.
      if (!existing)
        await insertEvent(tx, {
          accountId: trust.accountId,
          trustedIssuerId: trust.id,
          outcome: "connected",
          reason: null,
          subjectId: input.subjectId,
          email: input.email,
          clientId: input.clientId,
          clientName: input.clientName,
        });
      return { status: "connected", connectionId: familyId, organizationAccess };
    },
    undefined,
    "none",
  );
}

/** Records why an issuer's ID-JAG was refused, for the admin's troubleshooting. */
export async function recordMcpTrustedIssuerRefusal(
  db: Database,
  input: {
    accountId: string;
    trustedIssuerId: string;
    reason: McpAutoConnectRefusalReason;
    email: string | null;
    clientId: string | null;
    clientName: string | null;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: null },
    async (tx) =>
      insertEvent(tx, {
        ...input,
        outcome: "refused",
        subjectId: null,
      }),
    undefined,
    "none",
  );
}

/* ------------------- Outbound: the organization's signing key ------------------- */

export type OrganizationIdentityIssuerKey = {
  accountId: string;
  keyId: string;
  algorithm: "RS256" | "ES256";
  publicJwk: Record<string, unknown>;
  privateKeyEncrypted: string;
  createdAt: Date;
};

/** The organization's signing key, or null before an admin first turns auto-connect on. */
export async function getOrganizationIdentityIssuerKey(
  db: Database,
  accountId: string,
): Promise<OrganizationIdentityIssuerKey | null> {
  return await withRlsContext(
    db,
    { accountId, workspaceId: null },
    async (tx) => {
      const [row] = await rawRows<{
        account_id: string;
        key_id: string;
        algorithm: string;
        public_jwk: unknown;
        private_key_encrypted: string;
        created_at: Date | string;
      }>(
        tx,
        sql`select account_id, key_id, algorithm, public_jwk, private_key_encrypted, created_at
          from organization_identity_issuers where account_id = ${accountId}::uuid`,
      );
      return row ? mapIdentityKey(row) : null;
    },
    undefined,
    "none",
  );
}

/** Creates the organization's signing key once; a concurrent or repeated call returns the first. */
export async function ensureOrganizationIdentityIssuerKey(
  db: Database,
  scope: { accountId: string },
  create: () => Pick<
    OrganizationIdentityIssuerKey,
    "keyId" | "algorithm" | "publicJwk" | "privateKeyEncrypted"
  >,
  authorize: AuthorizeOrganizationConnectorAdministration,
): Promise<OrganizationIdentityIssuerKey> {
  const existing = await getOrganizationIdentityIssuerKey(db, scope.accountId);
  if (existing) return existing;
  const key = create();
  return await withOrganizationAdministrator(
    db,
    scope.accountId,
    authorize,
    async (tx, subjectId) => {
      await tx.execute(sql`insert into organization_identity_issuers (
        account_id, key_id, algorithm, public_jwk, private_key_encrypted, created_by_subject_id
      ) values (
        ${scope.accountId}::uuid, ${key.keyId}, ${key.algorithm},
        ${JSON.stringify(key.publicJwk)}::jsonb, ${key.privateKeyEncrypted}, ${subjectId}
      )
      on conflict (account_id) do nothing`);
      const [row] = await rawRows<{
        account_id: string;
        key_id: string;
        algorithm: string;
        public_jwk: unknown;
        private_key_encrypted: string;
        created_at: Date | string;
      }>(
        tx,
        sql`select account_id, key_id, algorithm, public_jwk, private_key_encrypted, created_at
          from organization_identity_issuers where account_id = ${scope.accountId}::uuid`,
      );
      if (!row) throw new Error("Organization signing key was not saved");
      return mapIdentityKey(row);
    },
  );
}

/* --------------------------------- Helpers --------------------------------- */

async function listTrustedIssuerSummaries(
  tx: Database,
  accountId: string,
  trustedIssuerId?: string,
): Promise<McpTrustedIssuerSummary[]> {
  const rows = await rawRows<
    TrustedIssuerRow & {
      connected_people: number | string;
      last_connected_at: Date | string | null;
      last_refusal_reason: string | null;
      last_refusal_at: Date | string | null;
    }
  >(
    tx,
    sql`select ${TRUST_COLUMNS},
        coalesce(people.connected_people, 0) as connected_people,
        people.last_connected_at,
        refusal.reason as last_refusal_reason,
        refusal.created_at as last_refusal_at
      from organization_mcp_trusted_issuers trust
      left join lateral (
        select count(*) as connected_people, max(subject.last_connected_at) as last_connected_at
        from organization_mcp_trusted_issuer_subjects subject
        where subject.trusted_issuer_id = trust.id
      ) people on true
      left join lateral (
        select event.reason, event.created_at
        from organization_mcp_trusted_issuer_events event
        where event.trusted_issuer_id = trust.id and event.outcome = 'refused'
        order by event.created_at desc
        limit 1
      ) refusal on true
      where trust.account_id = ${accountId}::uuid
        ${trustedIssuerId === undefined ? sql`` : sql`and trust.id = ${trustedIssuerId}::uuid`}
      order by trust.created_at, trust.id`,
  );
  return rows.map((row) => {
    const lastConnectedAt = row.last_connected_at ? new Date(row.last_connected_at) : null;
    const lastRefusalAt = row.last_refusal_at ? new Date(row.last_refusal_at) : null;
    const reason = refusalReason(row.last_refusal_reason);
    return {
      ...mapTrust(row),
      connectedPeople: Number(row.connected_people),
      lastConnectedAt,
      // A refusal older than the last connection is settled history.
      lastRefusal:
        reason && lastRefusalAt && (!lastConnectedAt || lastRefusalAt > lastConnectedAt)
          ? { reason, at: lastRefusalAt }
          : null,
    };
  });
}

async function setTrustedIssuerConnectionAccess(
  tx: Database,
  accountId: string,
  trustedIssuerId: string,
  organizationAccess: OrganizationAccessPolicy,
): Promise<void> {
  const access = JSON.stringify(organizationAccess);
  await tx.execute(sql`update mcp_oauth_access_tokens token
    set organization_access = ${access}::jsonb
    from mcp_oauth_refresh_tokens anchor
    where anchor.trusted_issuer_id = ${trustedIssuerId}::uuid
      and anchor.account_id = ${accountId}::uuid
      and token.refresh_family_id = anchor.family_id
      and token.revoked_at is null`);
  await tx.execute(sql`update mcp_oauth_refresh_tokens
    set organization_access = ${access}::jsonb
    where trusted_issuer_id = ${trustedIssuerId}::uuid
      and account_id = ${accountId}::uuid
      and revoked_at is null`);
}

async function revokeTrustedIssuerConnections(
  tx: Database,
  accountId: string,
  trustedIssuerId: string,
): Promise<void> {
  await tx.execute(sql`update mcp_oauth_access_tokens token
    set revoked_at = coalesce(token.revoked_at, clock_timestamp())
    from mcp_oauth_refresh_tokens anchor
    where anchor.trusted_issuer_id = ${trustedIssuerId}::uuid
      and anchor.account_id = ${accountId}::uuid
      and token.refresh_family_id = anchor.family_id`);
  await tx.execute(sql`update mcp_oauth_refresh_tokens
    set revoked_at = coalesce(revoked_at, clock_timestamp())
    where trusted_issuer_id = ${trustedIssuerId}::uuid
      and account_id = ${accountId}::uuid`);
}

async function insertEvent(
  tx: Database,
  input: {
    accountId: string;
    trustedIssuerId: string;
    outcome: "connected" | "refused";
    reason: McpAutoConnectRefusalReason | null;
    subjectId: string | null;
    email: string | null;
    clientId: string | null;
    clientName: string | null;
  },
): Promise<void> {
  await tx.execute(sql`insert into organization_mcp_trusted_issuer_events (
    trusted_issuer_id, account_id, outcome, reason, subject_id, email, client_id, client_name
  ) values (
    ${input.trustedIssuerId}::uuid, ${input.accountId}::uuid, ${input.outcome},
    ${input.outcome === "refused" ? (input.reason ?? "malformed") : null}, ${input.subjectId},
    ${boundedEmail(input.email)}, ${bounded(input.clientId, 2048)}, ${bounded(input.clientName, 200)}
  )`);
  await tx.execute(sql`delete from organization_mcp_trusted_issuer_events
    where trusted_issuer_id = ${input.trustedIssuerId}::uuid
      and id in (
        select id from organization_mcp_trusted_issuer_events
        where trusted_issuer_id = ${input.trustedIssuerId}::uuid
        order by created_at desc, id
        offset ${EVENTS_KEPT_PER_ISSUER}
      )`);
}

/**
 * Whether `subjectId` is an active human member of the organization. The
 * database check raises for a member who is not active, so it runs in a
 * savepoint; the subject context is restored afterwards.
 */
/**
 * Whether an auto-connected login may still be renewed: its connector is
 * still on, still connects people automatically with the same app setup, and
 * still reaches the login's workspace, and its owner is still an active
 * member. Read in the login's workspace, as a member sees it.
 */
export async function autoConnectLoginStillConnects(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    connectorId: string;
    audience: string;
    clientId: string;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const [connector] = await rawRows<{ config: Record<string, unknown> | null }>(
        tx,
        sql`select config from organization_connectors
          where id = ${input.connectorId}::uuid and account_id = ${input.accountId}::uuid
            and status = 'active'`,
      );
      const autoConnect = connector?.config?.autoConnect;
      if (!autoConnect || typeof autoConnect !== "object") return false;
      const setup = autoConnect as Record<string, unknown>;
      if (setup.authorizationServerIssuer !== input.audience || setup.clientId !== input.clientId)
        return false;
      return await isActiveMember(tx, input.accountId, input.subjectId);
    },
    undefined,
    "none",
  );
}

async function isActiveMember(
  tx: Database,
  accountId: string,
  subjectId: string,
): Promise<boolean> {
  if (!subjectId.startsWith("user:")) return false;
  const [previous] = await rawRows<{ subject: string | null }>(
    tx,
    sql`select current_setting('opengeni.subject_id', true) as subject`,
  );
  await setSubjectRlsContext(tx, subjectId);
  try {
    return await tx.transaction(
      async (savepoint) =>
        (await assertActiveManagedHumanOrganizationMembership(savepoint, {
          accountId,
          subjectId,
        })) !== null,
    );
  } catch (error) {
    if (nestedPostgresSqlState(error) === "42501") return false;
    throw error;
  } finally {
    await tx.execute(
      sql`select set_config('opengeni.subject_id', ${previous?.subject ?? ""}, true)`,
    );
  }
}

function mapTrust(row: TrustedIssuerRow): McpTrustedIssuerRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    provider: row.provider === "claude" || row.provider === "okta" ? row.provider : "other",
    issuer: row.issuer,
    jwksUri: row.jwks_uri,
    allowedClientIds: Array.isArray(row.allowed_client_ids)
      ? row.allowed_client_ids.filter((value): value is string => typeof value === "string")
      : null,
    organizationAccess: OrganizationAccessPolicy.parse(row.organization_access),
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapIdentityKey(row: {
  account_id: string;
  key_id: string;
  algorithm: string;
  public_jwk: unknown;
  private_key_encrypted: string;
  created_at: Date | string;
}): OrganizationIdentityIssuerKey {
  return {
    accountId: row.account_id,
    keyId: row.key_id,
    algorithm: row.algorithm === "ES256" ? "ES256" : "RS256",
    publicJwk: (row.public_jwk ?? {}) as Record<string, unknown>,
    privateKeyEncrypted: row.private_key_encrypted,
    createdAt: new Date(row.created_at),
  };
}

function refusalReason(value: string | null): McpAutoConnectRefusalReason | null {
  if (value === null) return null;
  const parsed = McpAutoConnectRefusalReason.safeParse(value);
  return parsed.success ? parsed.data : "malformed";
}

/** A refresh-token hash nobody holds a token for: the connection's anchor. */
function unusableTokenHash(): string {
  return sha256(`anchor:${randomBytes(32).toString("base64url")}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedEmail(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length >= 3 && trimmed.length <= 320 ? trimmed : null;
}

function bounded(value: string | null, max: number): string | null {
  if (!value) return null;
  return value.length <= max ? value : value.slice(0, max);
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** The scope every auto-connected token carries. */
export const MCP_AUTO_CONNECT_SCOPE = MCP_OAUTH_SCOPE;
