import { Permission, ToolGatewayIdentity, type AccessGrant } from "@opengeni/contracts";
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
  workspaceId: string;
  subjectId: string;
  resource: string;
  permissions: AccessGrant["permissions"];
  toolIdentities: Array<{ serverId: string; toolName: string }>;
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
  workspace_id: string;
  subject_id: string;
  resource: string;
  permissions: unknown;
  tool_identities: unknown;
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
      update mcp_oauth_clients client
      set expires_at = greatest(
        client.expires_at,
        clock_timestamp() + interval '31 days'
      )
      from reaped
      where client.client_id = ${clientId}
        and client.expires_at > clock_timestamp()
      returning client.client_id, client.redirect_uris, client.client_name,
        client.grant_types, client.response_types, client.created_at`,
  );
  return row ? mapClient(row) : null;
}

export async function createMcpOAuthAuthorizationRequest(
  db: Database,
  input: McpOAuthAuthorizationRequest,
): Promise<void> {
  await db.execute(sql`insert into mcp_oauth_authorization_requests (
    request_hash, client_id, account_id, workspace_id, subject_id, resource,
    redirect_uri, code_challenge, state, permissions, tool_identities, expires_at
  ) values (
    ${input.requestHash}, ${input.clientId}, ${input.accountId}, ${input.workspaceId},
    ${input.subjectId}, ${input.resource}, ${input.redirectUri}, ${input.codeChallenge},
    ${input.state}, ${JSON.stringify(input.permissions)}::jsonb,
    ${JSON.stringify(input.toolIdentities)}::jsonb, ${input.expiresAt.toISOString()}::timestamptz
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
        redirect_uri, code_challenge, state, permissions, tool_identities, expires_at
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
          redirect_uri, code_challenge, state, permissions, tool_identities, expires_at`,
    );
    if (!row) return null;
    await tx.execute(sql`insert into mcp_oauth_authorization_codes (
      code_hash, client_id, account_id, workspace_id, subject_id, resource,
      redirect_uri, code_challenge, permissions, tool_identities, expires_at
    ) values (
      ${input.codeHash}, ${row.client_id}, ${row.account_id}, ${row.workspace_id},
      ${row.subject_id}, ${row.resource}, ${row.redirect_uri}, ${row.code_challenge},
      ${JSON.stringify(row.permissions)}::jsonb, ${JSON.stringify(row.tool_identities)}::jsonb,
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
          permissions, tool_identities`,
    );
    if (!row) return null;
    const familyId = crypto.randomUUID();
    if (input.refreshTokenHash) {
      await tx.execute(sql`insert into mcp_oauth_refresh_tokens (
        token_hash, family_id, generation, client_id, account_id, workspace_id,
        subject_id, resource, permissions, tool_identities, expires_at
      ) values (
        ${input.refreshTokenHash}, ${familyId}, 1, ${row.client_id}, ${row.account_id},
        ${row.workspace_id}, ${row.subject_id}, ${row.resource},
        ${JSON.stringify(row.permissions)}::jsonb, ${JSON.stringify(row.tool_identities)}::jsonb,
        ${input.refreshExpiresAt.toISOString()}::timestamptz
      )`);
    }
    await tx.execute(sql`insert into mcp_oauth_access_tokens (
      token_hash, refresh_family_id, refresh_generation, client_id, account_id,
      workspace_id, subject_id, resource, permissions, tool_identities, expires_at
    ) values (
      ${input.accessTokenHash}, ${familyId}, 1, ${row.client_id}, ${row.account_id},
      ${row.workspace_id}, ${row.subject_id}, ${row.resource},
      ${JSON.stringify(row.permissions)}::jsonb, ${JSON.stringify(row.tool_identities)}::jsonb,
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
          subject_id, resource, permissions, tool_identities, revoked_at,
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
    await tx.execute(sql`update mcp_oauth_refresh_tokens
      set revoked_at = clock_timestamp()
      where token_hash = ${input.refreshTokenHash}`);
    const generation = Number(row.generation) + 1;
    await tx.execute(sql`insert into mcp_oauth_refresh_tokens (
      token_hash, family_id, generation, client_id, account_id, workspace_id,
      subject_id, resource, permissions, tool_identities, expires_at
    ) values (
      ${input.nextRefreshTokenHash}, ${row.family_id}, ${generation}, ${row.client_id},
      ${row.account_id}, ${row.workspace_id}, ${row.subject_id}, ${row.resource},
      ${JSON.stringify(row.permissions)}::jsonb, ${JSON.stringify(row.tool_identities)}::jsonb,
      ${input.refreshExpiresAt.toISOString()}::timestamptz
    )`);
    await tx.execute(sql`insert into mcp_oauth_access_tokens (
      token_hash, refresh_family_id, refresh_generation, client_id, account_id,
      workspace_id, subject_id, resource, permissions, tool_identities, expires_at
    ) values (
      ${input.accessTokenHash}, ${row.family_id}, ${generation}, ${row.client_id},
      ${row.account_id}, ${row.workspace_id}, ${row.subject_id}, ${row.resource},
      ${JSON.stringify(row.permissions)}::jsonb, ${JSON.stringify(row.tool_identities)}::jsonb,
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
        account_id, workspace_id, subject_id, resource, permissions, tool_identities, expires_at
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
  return await withWorkspaceSubjectRls(
    db,
    access.workspaceId,
    access.subjectId,
    async (scopedDb) => {
      if (!(await subjectHasLiveWorkspaceAuthorityInScope(scopedDb, access))) return null;
      const [membership] = await rawRows<{
        permissions: unknown;
        account_id: string;
      }>(
        scopedDb,
        sql`select membership.permissions, workspace.account_id
          from workspace_memberships membership
          join workspaces workspace on workspace.id = membership.workspace_id
          where membership.workspace_id = ${access.workspaceId}
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
        workspaceId: access.workspaceId,
        subjectId: access.subjectId,
        permissions,
        principalKind: "human_session",
        metadata: { mcpOAuth: true, refreshFamilyId: access.refreshFamilyId },
      };
    },
  );
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
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Invalid MCP OAuth string array persisted in database");
  }
  return value;
}
