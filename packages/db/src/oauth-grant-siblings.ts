import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows } from "./database";

/**
 * A provider that ends a whole OAuth grant (one provider account and one
 * OAuth client) when any one of its refresh tokens is revoked or refused.
 * Connections of one account that share the client share the grant, even
 * across integrations (Gmail, Drive and Calendar), workspaces and
 * organizations. Matching is by provider family, client and account, never by
 * provider domain alone.
 */
export type OAuthGrantFamily = {
  id: string;
  /** Token endpoint origins (lowercase) that identify the provider. */
  tokenEndpointOrigins: readonly string[];
  /** Provider domains (and their subdomains) of rows without a saved token endpoint. */
  providerDomainSuffixes: readonly string[];
  /** `metadata.providerFamily` of the provider's Integration connections. */
  providerFamily: string;
  /** Verified metadata keys holding the provider's stable account id. */
  subjectMetadataKeys: readonly string[];
  /** Verified metadata keys holding the account's email. */
  emailMetadataKeys: readonly string[];
};

/** Google revokes every token one Google account gave one OAuth client. */
export const GOOGLE_OAUTH_GRANT_FAMILY: OAuthGrantFamily = Object.freeze({
  id: "google",
  tokenEndpointOrigins: Object.freeze([
    "https://oauth2.googleapis.com",
    "https://accounts.google.com",
    "https://www.googleapis.com",
  ]),
  providerDomainSuffixes: Object.freeze(["googleapis.com"]),
  providerFamily: "google",
  subjectMetadataKeys: Object.freeze(["googleSubject"]),
  emailMetadataKeys: Object.freeze([
    "gmailEmail",
    "googleDriveEmail",
    "googleCalendarEmail",
    "providerEmail",
  ]),
});

export const OAUTH_GRANT_FAMILIES: readonly OAuthGrantFamily[] = Object.freeze([
  GOOGLE_OAUTH_GRANT_FAMILY,
]);

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The shared-grant family of a stored credential's token endpoint, if any. */
export function oauthGrantFamilyForTokenEndpoint(
  tokenEndpoint: unknown,
  families: readonly OAuthGrantFamily[] = OAUTH_GRANT_FAMILIES,
): OAuthGrantFamily | undefined {
  const text = textValue(tokenEndpoint);
  if (!text) return undefined;
  let origin: string;
  try {
    origin = new URL(text).origin.toLowerCase();
  } catch {
    return undefined;
  }
  return families.find((family) => family.tokenEndpointOrigins.includes(origin));
}

/** Migration 1611's checks; created withheld until a later migration grants them. */
export const OAUTH_GRANT_SHARED_ROUTINE =
  "opengeni_private.oauth_grant_shared_with_live_connection_v1(uuid, text, text[], text[], text, text[], text[])";
export const OAUTH_GRANT_REAUTH_SIBLINGS_ROUTINE =
  "opengeni_private.oauth_grant_reauth_siblings_v1(uuid, text, text[], text[], text, text[], text[])";

async function routineGranted(db: Database, routine: string): Promise<boolean> {
  const [row] = await rawRows<{ granted: boolean | null }>(
    db,
    sql`select has_function_privilege(to_regprocedure(${routine})::oid, 'EXECUTE') as granted`,
  );
  return row?.granted === true;
}

function familyParams(family: OAuthGrantFamily) {
  return sql`${sql.param([...family.tokenEndpointOrigins])}::text[],
    ${sql.param([...family.providerDomainSuffixes])}::text[],
    ${family.providerFamily},
    ${sql.param([...family.subjectMetadataKeys])}::text[],
    ${sql.param([...family.emailMetadataKeys])}::text[]`;
}

export type OAuthGrantLookup = {
  /** The connection being disconnected or found broken. */
  connectionId: string;
  /** Its OAuth client id, from its stored credential. */
  clientId: string | undefined;
  family: OAuthGrantFamily;
};

/**
 * Whether another live (not revoked) connection anywhere in the deployment
 * may hold the same provider grant: same family, the same or an unknown
 * client, and not provably another account. Only a yes/no leaves the
 * database. Null while the check is not granted (a database before the
 * follow-up grant of migration 1611): the caller must then assume yes.
 */
export async function oauthGrantSharedWithLiveConnection(
  db: Database,
  input: OAuthGrantLookup,
): Promise<boolean | null> {
  return await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    if (!(await routineGranted(scoped, OAUTH_GRANT_SHARED_ROUTINE))) return null;
    const [row] = await rawRows<{ shared: boolean | null }>(
      scoped,
      sql`select opengeni_private.oauth_grant_shared_with_live_connection_v1(
        ${input.connectionId}::uuid, ${input.clientId ?? null}::text, ${familyParams(input.family)}
      ) as shared`,
    );
    return row?.shared !== false;
  });
}

/** An active connection that provably held a grant the provider just refused. */
export type OAuthGrantSibling = {
  workspaceId: string;
  connectionId: string;
  subjectId: string | null;
  version: number;
  providerDomain: string;
};

/**
 * The other active connections, in any workspace or organization, that
 * may hold the grant of `connectionId`, which must already be needs_reauth
 * because its provider refused that grant: same family, same known client and
 * provably the same account (at most 100). The caller confirms each with its
 * own refresh before marking it. Null while the check is not granted.
 */
export async function oauthGrantReauthSiblings(
  db: Database,
  input: OAuthGrantLookup,
): Promise<OAuthGrantSibling[] | null> {
  if (!input.clientId) return [];
  return await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    if (!(await routineGranted(scoped, OAUTH_GRANT_REAUTH_SIBLINGS_ROUTINE))) return null;
    const rows = await rawRows<{
      workspace_id: string;
      connection_id: string;
      subject_id: string | null;
      version: number;
      provider_domain: string;
    }>(
      scoped,
      sql`select workspace_id, connection_id, subject_id, version, provider_domain
        from opengeni_private.oauth_grant_reauth_siblings_v1(
          ${input.connectionId}::uuid, ${input.clientId}::text, ${familyParams(input.family)}
        )`,
    );
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      connectionId: row.connection_id,
      subjectId: row.subject_id,
      version: Number(row.version),
      providerDomain: row.provider_domain,
    }));
  });
}
