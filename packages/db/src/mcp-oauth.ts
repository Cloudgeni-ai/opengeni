import {
  OrganizationAccessPolicy,
  Permission,
  ToolGatewayIdentity,
  type AccessGrant,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, type Database, withWorkspaceSubjectRls } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import { subjectHasLiveWorkspaceAuthorityInScope } from "./workspace-authority";

export class McpOAuthClientRegistrationRateLimitError extends Error {
  readonly name = "McpOAuthClientRegistrationRateLimitError";
  readonly code = "mcp_oauth_client_registration_rate_limited";
}

export type McpOAuthClient = {
  clientId: string;
  redirectUris: string[];
  clientName: string | null;
  grantTypes: Array<"authorization_code" | "refresh_token">;
  responseTypes: ["code"];
  createdAt: Date;
};

export type McpOAuthGrantSnapshot = {
  accountId: string;
  /** Null for an organization connection, which carries organizationAccess. */
  workspaceId: string | null;
  subjectId: string;
  resource: string;
  permissions: AccessGrant["permissions"];
  toolIdentities: Array<{ serverId: string; toolName: string }>;
  /** What an organization connection may do and where; null for a workspace grant. */
  organizationAccess: OrganizationAccessPolicy | null;
};

export type McpOAuthAuthorizationRequest = McpOAuthGrantSnapshot & {
  requestHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  expiresAt: Date;
};

export type McpOAuthAccess = McpOAuthGrantSnapshot & {
  tokenHash: string;
  clientId: string;
  refreshFamilyId: string;
  refreshGeneration: number;
  expiresAt: Date;
};

type ClientRow = {
  client_id: string;
  redirect_uris: unknown;
  client_name: string | null;
  grant_types: unknown;
  response_types: unknown;
  created_at: Date | string;
};

type GrantRow = {
  account_id: string;
  workspace_id: string | null;
  subject_id: string;
  resource: string;
  permissions: unknown;
  tool_identities: unknown;
  organization_access: unknown;
};

export async function registerMcpOAuthClient(
  db: Database,
  input: {
    clientId: string;
    redirectUris: string[];
    clientName: string | null;
    grantTypes: Array<"authorization_code" | "refresh_token">;
    responseTypes: ["code"];
    registrationScopeHash: string;
  },
): Promise<McpOAuthClient> {
  try {
    const [row] = await rawRows<ClientRow>(
      db,
      sql`select client_id, redirect_uris, client_name, grant_types, response_types, created_at
        from opengeni_private.register_mcp_oauth_client(
          ${input.clientId}, ${JSON.stringify(input.redirectUris)}::jsonb, ${input.clientName},
          ${JSON.stringify(input.grantTypes)}::jsonb, ${JSON.stringify(input.responseTypes)}::jsonb,
          ${input.registrationScopeHash}
        )`,
    );
    if (!row) throw new Error("MCP OAuth client registration was not persisted");
    return mapClient(row);
  } catch (error) {
    if (nestedPostgresSqlState(error) === "P0004") {
      throw new McpOAuthClientRegistrationRateLimitError();
    }
    throw error;
  }
}

export async function getMcpOAuthClient(
  db: Database,
  clientId: string,
): Promise<McpOAuthClient | null> {
  const [row] = await rawRows<ClientRow>(
    db,
    sql`with reaped as (
        select opengeni_private.reap_mcp_oauth_state(128)
      )
      select client.client_id, client.redirect_uris, client.client_name,
        client.grant_types, client.response_types, client.created_at
      from mcp_oauth_clients client
      cross join reaped
      where client.client_id = ${clientId}
        and client.expires_at > clock_timestamp()
      limit 1`,
  );
  return row ? mapClient(row) : null;
}

async function extendMcpOAuthClientRetention(db: Database, clientId: string): Promise<void> {
  await db.execute(sql`update mcp_oauth_clients
    set expires_at = greatest(expires_at, clock_timestamp() + interval '31 days')
    where client_id = ${clientId}
      and expires_at > clock_timestamp()`);
}

export async function createMcpOAuthAuthorizationRequest(
  db: Database,
  input: McpOAuthAuthorizationRequest,
): Promise<void> {
  await db.execute(sql`insert into mcp_oauth_authorization_requests (
    request_hash, client_id, account_id, workspace_id, subject_id, resource,
    redirect_uri, code_challenge, state, permissions, tool_identities, organization_access, expires_at
  ) values (
    ${input.requestHash}, ${input.clientId}, ${input.accountId}, ${input.workspaceId},
    ${input.subjectId}, ${input.resource}, ${input.redirectUri}, ${input.codeChallenge},
    ${input.state}, ${JSON.stringify(input.permissions)}::jsonb,
    ${JSON.stringify(input.toolIdentities)}::jsonb, ${jsonOrNull(input.organizationAccess)}::jsonb,
    ${input.expiresAt.toISOString()}::timestamptz
  )`);
}

export async function getMcpOAuthAuthorizationRequest(
  db: Database,
  requestHash: string,
): Promise<McpOAuthAuthorizationRequest | null> {
  const [row] = await rawRows<
    GrantRow & {
      request_hash: string;
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      state: string | null;
      expires_at: Date | string;
    }
  >(
    db,
    sql`select request_hash, client_id, account_id, workspace_id, subject_id, resource,
        redirect_uri, code_challenge, state, permissions, tool_identities, organization_access, expires_at
      from mcp_oauth_authorization_requests
      where request_hash = ${requestHash} and expires_at > clock_timestamp()`,
  );
  return row
    ? {
        requestHash: row.request_hash,
        clientId: row.client_id,
        ...mapGrant(row),
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        state: row.state,
        expiresAt: new Date(row.expires_at),
      }
    : null;
}

export async function deleteMcpOAuthAuthorizationRequest(
  db: Database,
  requestHash: string,
): Promise<void> {
  await db.execute(
    sql`delete from mcp_oauth_authorization_requests where request_hash = ${requestHash}`,
  );
}

export async function rebindMcpOAuthAuthorizationRequest(
  db: Database,
  input: {
    requestHash: string;
    subjectId: string;
    accountId: string;
    workspaceId: string;
    permissions: AccessGrant["permissions"];
    toolIdentities: Array<{ serverId: string; toolName: string }>;
  },
): Promise<boolean> {
  const [row] = await rawRows<{ request_hash: string }>(
    db,
    sql`update mcp_oauth_authorization_requests
      set account_id = ${input.accountId},
          workspace_id = ${input.workspaceId},
          permissions = ${JSON.stringify(input.permissions)}::jsonb,
          tool_identities = ${JSON.stringify(input.toolIdentities)}::jsonb
      where request_hash = ${input.requestHash}
        and subject_id = ${input.subjectId}
        and expires_at > clock_timestamp()
      returning request_hash`,
  );
  return Boolean(row);
}

export async function consumeMcpOAuthAuthorizationRequest(
  db: Database,
  input: {
    requestHash: string;
    subjectId: string;
    codeHash: string;
    codeExpiresAt: Date;
  },
): Promise<McpOAuthAuthorizationRequest | null> {
  return await db.transaction(async (tx) => {
    const [row] = await rawRows<
      GrantRow & {
        request_hash: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        state: string | null;
        expires_at: Date | string;
      }
    >(
      tx,
      sql`delete from mcp_oauth_authorization_requests
        where request_hash = ${input.requestHash}
          and subject_id = ${input.subjectId}
          and expires_at > clock_timestamp()
        returning request_hash, client_id, account_id, workspace_id, subject_id, resource,
          redirect_uri, code_challenge, state, permissions, tool_identities, organization_access, expires_at`,
    );
    if (!row) return null;
    await extendMcpOAuthClientRetention(tx, row.client_id);
    await tx.execute(sql`insert into mcp_oauth_authorization_codes (
      code_hash, client_id, account_id, workspace_id, subject_id, resource,
      redirect_uri, code_challenge, permissions, tool_identities, organization_access, expires_at
    ) values (
      ${input.codeHash}, ${row.client_id}, ${row.account_id}, ${row.workspace_id},
      ${row.subject_id}, ${row.resource}, ${row.redirect_uri}, ${row.code_challenge},
      ${JSON.stringify(row.permissions)}::jsonb, ${JSON.stringify(row.tool_identities)}::jsonb, ${jsonOrNull(row.organization_access)}::jsonb,
      ${input.codeExpiresAt.toISOString()}::timestamptz
    )`);
    return {
      requestHash: row.request_hash,
      clientId: row.client_id,
      ...mapGrant(row),
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      state: row.state,
      expiresAt: new Date(row.expires_at),
    };
  });
}

export async function exchangeMcpOAuthAuthorizationCode(
  db: Database,
  input: {
    codeHash: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    codeChallenge: string;
    accessTokenHash: string;
    refreshTokenHash: string | null;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
  },
): Promise<McpOAuthAccess | null> {
  return await db.transaction(async (tx) => {
    const [row] = await rawRows<GrantRow & { client_id: string }>(
      tx,
      sql`delete from mcp_oauth_authorization_codes
        where code_hash = ${input.codeHash}
          and client_id = ${input.clientId}
          and redirect_uri = ${input.redirectUri}
          and resource = ${input.resource}
          and code_challenge = ${input.codeChallenge}
          and expires_at > clock_timestamp()
        returning client_id, account_id, workspace_id, subject_id, resource,
          permissions, tool_identities, organization_access`,
    );
    if (!row) return null;
    await extendMcpOAuthClientRetention(tx, row.client_id);
    const familyId = crypto.randomUUID();
    if (input.refreshTokenHash) {
      await tx.execute(sql`insert into mcp_oauth_refresh_tokens (
        token_hash, family_id, generation, client_id, account_id, workspace_id,
        subject_id, resource, permissions, tool_identities, organization_access, connected_at, expires_at
      ) values (
        ${input.refreshTokenHash}, ${familyId}, 1, ${row.client_id}, ${row.account_id},
        ${row.workspace_id}, ${row.subject_id}, ${row.resource},
        ${JSON.stringify(row.permissions)}::jsonb, ${JSON.stringify(row.tool_identities)}::jsonb, ${jsonOrNull(row.organization_access)}::jsonb,
        clock_timestamp(), ${input.refreshExpiresAt.toISOString()}::timestamptz
      )`);
    }
    await tx.execute(sql`insert into mcp_oauth_access_tokens (
      token_hash, refresh_family_id, refresh_generation, client_id, account_id,
      workspace_id, subject_id, resource, permissions, tool_identities, organization_access, expires_at
    ) values (
      ${input.accessTokenHash}, ${familyId}, 1, ${row.client_id}, ${row.account_id},
      ${row.workspace_id}, ${row.subject_id}, ${row.resource},
      ${JSON.stringify(row.permissions)}::jsonb, ${JSON.stringify(row.tool_identities)}::jsonb, ${jsonOrNull(row.organization_access)}::jsonb,
      ${input.accessExpiresAt.toISOString()}::timestamptz
    )`);
    return {
      tokenHash: input.accessTokenHash,
      clientId: row.client_id,
      refreshFamilyId: familyId,
      refreshGeneration: 1,
      ...mapGrant(row),
      expiresAt: input.accessExpiresAt,
    };
  });
}

export async function rotateMcpOAuthRefreshToken(
  db: Database,
  input: {
    refreshTokenHash: string;
    clientId: string;
    resource: string;
    accessTokenHash: string;
    nextRefreshTokenHash: string;
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
  },
): Promise<McpOAuthAccess | null> {
  return await db.transaction(async (tx) => {
    const [family] = await rawRows<{ family_id: string }>(
      tx,
      sql`select family_id
        from mcp_oauth_refresh_tokens
        where token_hash = ${input.refreshTokenHash}
          and client_id = ${input.clientId}
          and resource = ${input.resource}`,
    );
    if (!family) return null;
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtextextended(${`mcp-oauth-refresh-family:${family.family_id}`}, 0)
      )`,
    );
    const [row] = await rawRows<
      GrantRow & {
        client_id: string;
        family_id: string;
        generation: number;
        revoked_at: Date | string | null;
        active: boolean;
      }
    >(
      tx,
      sql`select client_id, family_id, generation, account_id, workspace_id,
          subject_id, resource, permissions, tool_identities, organization_access, revoked_at,
          expires_at > clock_timestamp() as active
        from mcp_oauth_refresh_tokens
        where token_hash = ${input.refreshTokenHash}
          and client_id = ${input.clientId}
          and resource = ${input.resource}
        for update`,
    );
    if (!row) return null;
    if (row.revoked_at !== null) {
      await revokeMcpOAuthRefreshFamily(tx, row.family_id);
      return null;
    }
    if (!row.active) return null;
    await extendMcpOAuthClientRetention(tx, row.client_id);
    await tx.execute(sql`update mcp_oauth_refresh_tokens
      set revoked_at = clock_timestamp()
      where token_hash = ${input.refreshTokenHash}`);
    const generation = Number(row.generation) + 1;
    await tx.execute(sql`insert into mcp_oauth_refresh_tokens (
      token_hash, family_id, generation, client_id, account_id, workspace_id,
      subject_id, resource, permissions, tool_identities, organization_access, connected_at, expires_at
    ) values (
      ${input.nextRefreshTokenHash}, ${row.family_id}, ${generation}, ${row.client_id},
      ${row.account_id}, ${row.workspace_id}, ${row.subject_id}, ${row.resource},
      ${JSON.stringify(row.permissions)}::jsonb, ${JSON.stringify(row.tool_identities)}::jsonb, ${jsonOrNull(row.organization_access)}::jsonb,
      (select previous.connected_at from mcp_oauth_refresh_tokens previous
        where previous.token_hash = ${input.refreshTokenHash}), ${input.refreshExpiresAt.toISOString()}::timestamptz
    )`);
    await tx.execute(sql`insert into mcp_oauth_access_tokens (
      token_hash, refresh_family_id, refresh_generation, client_id, account_id,
      workspace_id, subject_id, resource, permissions, tool_identities, organization_access, expires_at
    ) values (
      ${input.accessTokenHash}, ${row.family_id}, ${generation}, ${row.client_id},
      ${row.account_id}, ${row.workspace_id}, ${row.subject_id}, ${row.resource},
      ${JSON.stringify(row.permissions)}::jsonb, ${JSON.stringify(row.tool_identities)}::jsonb, ${jsonOrNull(row.organization_access)}::jsonb,
      ${input.accessExpiresAt.toISOString()}::timestamptz
    )`);
    return {
      tokenHash: input.accessTokenHash,
      clientId: row.client_id,
      refreshFamilyId: row.family_id,
      refreshGeneration: generation,
      ...mapGrant(row),
      expiresAt: input.accessExpiresAt,
    };
  });
}

async function revokeMcpOAuthRefreshFamily(db: Database, familyId: string): Promise<void> {
  await db.execute(sql`update mcp_oauth_refresh_tokens
    set revoked_at = coalesce(revoked_at, clock_timestamp())
    where family_id = ${familyId}`);
  await db.execute(sql`update mcp_oauth_access_tokens
    set revoked_at = coalesce(revoked_at, clock_timestamp())
    where refresh_family_id = ${familyId}`);
}

export async function resolveMcpOAuthAccessToken(
  db: Database,
  tokenHash: string,
): Promise<McpOAuthAccess | null> {
  const [row] = await rawRows<
    GrantRow & {
      token_hash: string;
      client_id: string;
      refresh_family_id: string;
      refresh_generation: number;
      expires_at: Date | string;
    }
  >(
    db,
    sql`select token_hash, client_id, refresh_family_id, refresh_generation,
        account_id, workspace_id, subject_id, resource, permissions, tool_identities,
        organization_access, expires_at
      from mcp_oauth_access_tokens
      where token_hash = ${tokenHash}
        and revoked_at is null
        and expires_at > clock_timestamp()`,
  );
  return row
    ? {
        tokenHash: row.token_hash,
        clientId: row.client_id,
        refreshFamilyId: row.refresh_family_id,
        refreshGeneration: Number(row.refresh_generation),
        ...mapGrant(row),
        expiresAt: new Date(row.expires_at),
      }
    : null;
}

export async function resolveLiveMcpOAuthGrant(
  db: Database,
  access: McpOAuthAccess,
): Promise<AccessGrant | null> {
  // Organization connections resolve per request through the person proof.
  const workspaceId = access.workspaceId;
  if (workspaceId === null) return null;
  return await withWorkspaceSubjectRls(db, workspaceId, access.subjectId, async (scopedDb) => {
    if (!(await subjectHasLiveWorkspaceAuthorityInScope(scopedDb, { ...access, workspaceId })))
      return null;
    const [membership] = await rawRows<{
      permissions: unknown;
      account_id: string;
    }>(
      scopedDb,
      sql`select membership.permissions, workspace.account_id
          from workspace_memberships membership
          join workspaces workspace on workspace.id = membership.workspace_id
          where membership.workspace_id = ${workspaceId}
            and membership.subject_id = ${access.subjectId}
          limit 1`,
    );
    if (membership && membership.account_id !== access.accountId) return null;
    const livePermissions = membership
      ? Permission.array().parse(membership.permissions)
      : access.permissions;
    const liveSet = new Set(livePermissions);
    const permissions = access.permissions.filter((permission) => liveSet.has(permission));
    if (!permissions.includes("workspace:read")) return null;
    return {
      accountId: access.accountId,
      workspaceId,
      subjectId: access.subjectId,
      permissions,
      principalKind: "human_session",
      metadata: { mcpOAuth: true, refreshFamilyId: access.refreshFamilyId },
    };
  });
}

/* ----------------------------------------------------------------------------
   Organization connections: an MCP OAuth grant bound to an organization and an
   access setting instead of one workspace. One connection is one refresh-token
   family; its live rows carry the setting.
   -------------------------------------------------------------------------- */

/** Bind a pending organization authorization request to the person's choice. */
export async function setMcpOAuthRequestOrganizationAccess(
  db: Database,
  input: {
    requestHash: string;
    subjectId: string;
    accountId: string;
    organizationAccess: OrganizationAccessPolicy;
  },
): Promise<boolean> {
  const [row] = await rawRows<{ request_hash: string }>(
    db,
    sql`update mcp_oauth_authorization_requests
      set account_id = ${input.accountId},
          organization_access = ${JSON.stringify(input.organizationAccess)}::jsonb
      where request_hash = ${input.requestHash}
        and subject_id = ${input.subjectId}
        and workspace_id is null
        and expires_at > clock_timestamp()
      returning request_hash`,
  );
  return Boolean(row);
}

export type OrganizationMcpConnection = {
  /** The refresh-token family: stable for the life of the connection. */
  id: string;
  accountId: string;
  subjectId: string;
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  organizationAccess: OrganizationAccessPolicy;
  connectedAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
};

/** Live organization connections, newest first. Pass subjectId for one person's own. */
export async function listOrganizationMcpConnections(
  db: Database,
  input: { accountId: string; subjectId?: string; connectionId?: string },
): Promise<OrganizationMcpConnection[]> {
  const rows = await rawRows<{
    family_id: string;
    account_id: string;
    subject_id: string;
    client_id: string;
    client_name: string | null;
    redirect_uris: unknown;
    organization_access: unknown;
    connected_at: Date | string | null;
    created_at: Date | string;
    expires_at: Date | string;
    last_used_at: Date | string | null;
  }>(
    db,
    sql`select refresh.family_id, refresh.account_id, refresh.subject_id, refresh.client_id,
        client.client_name, client.redirect_uris, refresh.organization_access,
        refresh.connected_at, refresh.created_at, refresh.expires_at,
        (select max(access.created_at) from mcp_oauth_access_tokens access
          where access.refresh_family_id = refresh.family_id) as last_used_at
      from mcp_oauth_refresh_tokens refresh
      join mcp_oauth_clients client on client.client_id = refresh.client_id
      where refresh.account_id = ${input.accountId}
        and refresh.organization_access is not null
        and refresh.revoked_at is null
        and refresh.expires_at > clock_timestamp()
        ${input.subjectId === undefined ? sql`` : sql`and refresh.subject_id = ${input.subjectId}`}
        ${input.connectionId === undefined ? sql`` : sql`and refresh.family_id = ${input.connectionId}::uuid`}
      order by coalesce(refresh.connected_at, refresh.created_at) desc, refresh.family_id`,
  );
  return rows.map((row) => ({
    id: row.family_id,
    accountId: row.account_id,
    subjectId: row.subject_id,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: stringArray(row.redirect_uris),
    organizationAccess: OrganizationAccessPolicy.parse(row.organization_access),
    connectedAt: new Date(row.connected_at ?? row.created_at),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at),
    expiresAt: new Date(row.expires_at),
  }));
}

/** Change what a connection can do; its next request uses the new setting. */
export async function updateOrganizationMcpConnectionAccess(
  db: Database,
  input: {
    accountId: string;
    connectionId: string;
    organizationAccess: OrganizationAccessPolicy;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtextextended(${`mcp-oauth-refresh-family:${input.connectionId}`}, 0)
      )`,
    );
    const access = JSON.stringify(input.organizationAccess);
    const updated = await rawRows<{ token_hash: string }>(
      tx,
      sql`update mcp_oauth_refresh_tokens
        set organization_access = ${access}::jsonb
        where family_id = ${input.connectionId}::uuid
          and account_id = ${input.accountId}
          and organization_access is not null
          and revoked_at is null
        returning token_hash`,
    );
    if (updated.length === 0) return false;
    await tx.execute(sql`update mcp_oauth_access_tokens
      set organization_access = ${access}::jsonb
      where refresh_family_id = ${input.connectionId}::uuid
        and account_id = ${input.accountId}
        and organization_access is not null`);
    return true;
  });
}

/** Disconnect: every token of the connection is refused from now on. */
export async function revokeOrganizationMcpConnection(
  db: Database,
  input: { accountId: string; connectionId: string },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [row] = await rawRows<{ family_id: string }>(
      tx,
      sql`select family_id from mcp_oauth_refresh_tokens
        where family_id = ${input.connectionId}::uuid
          and account_id = ${input.accountId}
          and organization_access is not null
        limit 1`,
    );
    if (!row) return false;
    await revokeMcpOAuthRefreshFamily(tx, row.family_id);
    return true;
  });
}

function mapClient(row: ClientRow): McpOAuthClient {
  return {
    clientId: row.client_id,
    redirectUris: stringArray(row.redirect_uris),
    clientName: row.client_name,
    grantTypes: stringArray(row.grant_types) as McpOAuthClient["grantTypes"],
    responseTypes: stringArray(row.response_types) as ["code"],
    createdAt: new Date(row.created_at),
  };
}

function mapGrant(row: GrantRow): McpOAuthGrantSnapshot {
  return {
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    subjectId: row.subject_id,
    resource: row.resource,
    permissions: Permission.array().parse(row.permissions),
    toolIdentities: ToolGatewayIdentity.array().parse(row.tool_identities),
    organizationAccess:
      row.organization_access === null || row.organization_access === undefined
        ? null
        : OrganizationAccessPolicy.parse(row.organization_access),
  };
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Invalid MCP OAuth string array persisted in database");
  }
  return value;
}
