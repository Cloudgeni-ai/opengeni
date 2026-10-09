/**
 * The Codex Apps designation on the shared subscription core (M3 PR 2b).
 *
 * Dormant until an organization's Codex cutover row is enabled: callers reach
 * this module only for that disposition, and every database routine it uses
 * refuses unless the cutover is enabled. Apps credentials load by their
 * designation, never through placement (design 6.3): the designation names
 * one shared Codex connection per workspace, written by an organization
 * administrator or that connection's delegated manager, and is usable in any
 * inference source mode. Reads and refreshes go through the
 * `*_subscription_codex_apps_*` routines (migration 0670), which recheck the
 * designation, the connection's scope and its health in the database and
 * serialize refresh on the same per-connection key as chat refresh.
 */
import { sql } from "drizzle-orm";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  accessTokenExpiry,
  CODEX_CLIENT_VERSION,
  CODEX_REFRESH_FALLBACK_MS,
  CODEX_REFRESH_WINDOW_MS,
  CodexAppsCredentialUnavailable,
  CodexReloginRequired,
  refreshCodexToken,
} from "@opengeni/codex";
import { withCodexTokenDeadline } from "./codex-token-resolver";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import { withLosslessContentWriteVersion } from "./lossless-json";
import * as schema from "./schema";
import { resolveSubscriptionConnectionId } from "./subscription-core-repository";

/** The designated core connection is no longer usable for Apps. */
export class SubscriptionCoreCodexAppsUnavailableError extends CodexAppsCredentialUnavailable {
  constructor(message = "Codex Apps authorization is no longer active") {
    super(message);
    this.name = "SubscriptionCoreCodexAppsUnavailableError";
  }
}

export type SubscriptionCoreCodexAppsDesignation = {
  connectionId: string;
  /** Connection health; only `active` can serve Apps requests. */
  status: string;
};

/**
 * The workspace's usable core Apps designation: the designation still names a
 * shared Codex connection in the workspace's scope, and the cutover is
 * enabled. Never returns credential material.
 */
export async function resolveSubscriptionCoreCodexAppsDesignation(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<SubscriptionCoreCodexAppsDesignation | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const [row] = await rawRows<{ connection_id: string; status: string }>(
        tx,
        sql`select connection_id::text as connection_id, status
          from opengeni_private.resolve_subscription_codex_apps_designation(
            ${input.accountId}::uuid, ${input.workspaceId}::uuid)`,
      );
      return row ? { connectionId: row.connection_id, status: row.status } : null;
    },
  );
}

/** The legacy `CodexAppsSettings` projection of the core designation row. */
export type SubscriptionCoreCodexAppsSettings = {
  credentialId: string | null;
  version: number;
  designatedAt: Date | null;
};

const NO_DESIGNATION: SubscriptionCoreCodexAppsSettings = {
  credentialId: null,
  version: 0,
  designatedAt: null,
};

async function readDesignationRow(
  tx: Database,
  input: { accountId: string; workspaceId: string },
): Promise<SubscriptionCoreCodexAppsSettings> {
  const [row] = await rawRows<{
    connection_id: string;
    version: number | string;
    updated_at: Date | string;
  }>(
    tx,
    sql`select connection_id::text as connection_id, version, updated_at
      from subscription_apps_designations
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid`,
  );
  return row
    ? {
        credentialId: row.connection_id,
        version: Number(row.version),
        designatedAt: new Date(row.updated_at),
      }
    : NO_DESIGNATION;
}

export async function getSubscriptionCoreCodexAppsSettings(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<SubscriptionCoreCodexAppsSettings> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => await readDesignationRow(tx, input),
  );
}

export type DesignateSubscriptionCoreCodexAppsResult =
  | ({ kind: "updated" } & SubscriptionCoreCodexAppsSettings)
  | ({ kind: "conflict" | "already_designated" } & SubscriptionCoreCodexAppsSettings)
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

function isRlsRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "42501" || causeCode === "42501";
}

async function withAppsAdministration<T>(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      // The same key the Apps request recheck holds, so a clear cannot commit
      // between that recheck and the request it authorizes.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`codex-apps-settings:${input.workspaceId}`}, 0))`,
      );
      return await fn(tx);
    },
  );
}

async function auditAppsDesignation(
  tx: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
  action: "codex_apps.designated" | "codex_apps.cleared",
  connectionId: string,
  version: number,
): Promise<void> {
  await tx.insert(schema.auditEvents).values(
    withLosslessContentWriteVersion(
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        action,
        targetType: "subscription_connection",
        targetId: connectionId,
        metadata: { version },
      },
      "metadata",
      "metadataCodecVersion",
    ),
  );
}

/**
 * Designate a shared Codex connection for Apps. Authorization is the
 * designation table's own policy: an organization administrator, or a
 * workspace administrator for a connection this workspace manages; the
 * connection must be active and in the workspace's scope. Legacy account ids
 * resolve through aliases first.
 */
export async function designateSubscriptionCoreCodexApps(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    connectionId: string;
    subjectId: string;
    expectedVersion: number;
  },
): Promise<DesignateSubscriptionCoreCodexAppsResult> {
  return await withAppsAdministration(db, input, async (tx) => {
    const current = await readDesignationRow(tx, input);
    if (current.version !== input.expectedVersion) return { kind: "conflict", ...current };
    if (current.credentialId !== null) return { kind: "already_designated", ...current };
    const connectionId = await resolveSubscriptionConnectionId(tx, {
      accountId: input.accountId,
      provider: "codex",
      connectionId: input.connectionId,
    });
    if (!connectionId) return { kind: "not_found" };
    const [connection] = await rawRows<{ status: string; kind: string; ownership: string }>(
      tx,
      sql`select status, kind, ownership from subscription_connections
        where account_id = ${input.accountId}::uuid and provider = 'codex'
          and id = ${connectionId}::uuid`,
    );
    if (!connection || connection.kind !== "subscription" || connection.ownership !== "shared")
      return { kind: "not_found" };
    if (connection.status !== "active") return { kind: "unavailable" };
    const version = current.version + 1;
    let written: { updated_at: Date | string } | undefined;
    try {
      written = await tx.transaction(async (savepoint) => {
        const [row] = await rawRows<{ updated_at: Date | string }>(
          savepoint as unknown as Database,
          sql`insert into subscription_apps_designations (
              account_id, workspace_id, connection_id, version, updated_by_subject_id, updated_at
            ) values (
              ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${connectionId}::uuid,
              ${version}, ${input.subjectId}, clock_timestamp()
            ) returning updated_at`,
        );
        return row;
      });
    } catch (error) {
      if (isRlsRefusal(error)) return { kind: "forbidden" };
      throw error;
    }
    if (!written) throw new Error("Core Codex Apps designation was not persisted");
    await auditAppsDesignation(tx, input, "codex_apps.designated", connectionId, version);
    return {
      kind: "updated",
      credentialId: connectionId,
      version,
      designatedAt: new Date(written.updated_at),
    };
  });
}

export type ClearSubscriptionCoreCodexAppsResult = {
  kind: "updated" | "unchanged" | "conflict" | "forbidden";
} & SubscriptionCoreCodexAppsSettings;

/**
 * Clear the designation, valid in any inference source mode. The core row is
 * deleted, so the projected version returns to 0 (no designation).
 */
export async function clearSubscriptionCoreCodexApps(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string; expectedVersion: number },
): Promise<ClearSubscriptionCoreCodexAppsResult> {
  return await withAppsAdministration(db, input, async (tx) => {
    const current = await readDesignationRow(tx, input);
    if (current.version !== input.expectedVersion) return { kind: "conflict", ...current };
    if (current.credentialId === null) return { kind: "unchanged", ...current };
    const removed = await rawRows<{ connection_id: string }>(
      tx,
      sql`delete from subscription_apps_designations
        where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
          and version = ${current.version}
        returning connection_id::text as connection_id`,
    );
    // The delete policy hides a row this subject may not manage.
    if (removed.length === 0) return { kind: "forbidden", ...current };
    await auditAppsDesignation(tx, input, "codex_apps.cleared", current.credentialId, 0);
    return { kind: "updated", ...NO_DESIGNATION };
  });
}

type AppsCredential = {
  refreshGeneration: number;
  tokens: { accessToken: string; refreshToken: string; idToken: string };
  chatgptAccountId: string | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
};

function encryptionKey(settings: Settings): Uint8Array {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new Error(
      "core Codex credential present but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
    );
  }
  return key;
}

function decodeTokens(key: Uint8Array, encrypted: string): AppsCredential["tokens"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptEnvironmentValue(key, encrypted));
  } catch {
    // Fixed text and no cause: a parse error would quote the plaintext.
    throw new Error("A core Codex credential could not be decrypted");
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    !record ||
    typeof record.access_token !== "string" ||
    typeof record.refresh_token !== "string" ||
    typeof record.id_token !== "string"
  ) {
    throw new Error("A core Codex credential does not hold the expected token object");
  }
  return {
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    idToken: record.id_token,
  };
}

type AppsTarget = { accountId: string; workspaceId: string; connectionId: string };

async function loadAppsCredential(
  db: Database,
  key: Uint8Array,
  target: AppsTarget,
): Promise<AppsCredential> {
  const row = await withRlsContext(
    db,
    { accountId: target.accountId, workspaceId: target.workspaceId },
    async (tx) =>
      (
        await rawRows<{
          status: string;
          refresh_generation: number | string;
          credential_encrypted: string | null;
          expires_at: Date | string | null;
          last_refresh_at: Date | string | null;
          provider_account_id: string | null;
        }>(
          tx,
          sql`select status, refresh_generation, credential_encrypted, expires_at,
              last_refresh_at, provider_account_id
            from opengeni_private.read_subscription_codex_apps_credential(
              ${target.accountId}::uuid, ${target.workspaceId}::uuid,
              ${target.connectionId}::uuid)`,
        )
      )[0],
  );
  if (!row) throw new SubscriptionCoreCodexAppsUnavailableError();
  if (row.status !== "active" || row.credential_encrypted === null) {
    // Still the authorized designation, but its sign-in must be renewed.
    throw new CodexReloginRequired("The designated Codex Apps account must be reconnected.");
  }
  return {
    refreshGeneration: Number(row.refresh_generation),
    tokens: decodeTokens(key, row.credential_encrypted),
    chatgptAccountId: row.provider_account_id,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
    lastRefreshAt: row.last_refresh_at === null ? null : new Date(row.last_refresh_at),
  };
}

type AppsRefreshOutcome =
  | { kind: "refreshed"; accessToken: string }
  | { kind: "superseded" }
  | { kind: "unavailable" }
  | { kind: "relogin"; message: string }
  | { kind: "error"; error: unknown };

export type SubscriptionCoreCodexAppsDeps = {
  refresh?: typeof refreshCodexToken;
  now?: () => Date;
};

/**
 * Rotate the designated connection's refresh token: begin authorizes by the
 * designation and takes the per-connection advisory key, the rotated token is
 * persisted immediately after the provider returns, and a permanent OAuth
 * refusal marks the connection needs-relogin under the same authorization.
 */
async function refreshAppsCredential(
  db: Database,
  key: Uint8Array,
  target: AppsTarget,
  observedRefreshGeneration: number,
  deps: SubscriptionCoreCodexAppsDeps,
): Promise<AppsRefreshOutcome> {
  const refresh = deps.refresh ?? refreshCodexToken;
  const now = deps.now ?? (() => new Date());
  return await withRlsContext(
    db,
    { accountId: target.accountId, workspaceId: target.workspaceId },
    async (tx): Promise<AppsRefreshOutcome> => {
      const [begun] = await rawRows<{
        refresh_generation: number | string;
        credential_encrypted: string;
      }>(
        tx,
        sql`select refresh_generation, credential_encrypted
          from opengeni_private.begin_subscription_codex_apps_refresh(
            ${target.accountId}::uuid, ${target.workspaceId}::uuid, ${target.connectionId}::uuid)`,
      );
      if (!begun) return { kind: "unavailable" };
      const generation = Number(begun.refresh_generation);
      if (generation !== observedRefreshGeneration) return { kind: "superseded" };
      try {
        const tokens = decodeTokens(key, begun.credential_encrypted);
        const next = await withCodexTokenDeadline(refresh(tokens.refreshToken));
        const rotated = {
          access_token: next.accessToken ?? tokens.accessToken,
          refresh_token: next.refreshToken ?? tokens.refreshToken,
          id_token: next.idToken ?? tokens.idToken,
        };
        // Persist before any other fallible work.
        const [persisted] = await rawRows<{ persisted: boolean }>(
          tx,
          sql`select opengeni_private.persist_subscription_codex_apps_refresh(
              ${target.accountId}::uuid, ${target.workspaceId}::uuid, ${target.connectionId}::uuid,
              ${generation}::bigint,
              ${encryptEnvironmentValue(key, JSON.stringify(rotated))},
              ${accessTokenExpiry(rotated.access_token)?.toISOString() ?? null}::timestamptz,
              ${now().toISOString()}::timestamptz
            ) as persisted`,
        );
        if (persisted?.persisted !== true) return { kind: "superseded" };
        return { kind: "refreshed", accessToken: rotated.access_token };
      } catch (error) {
        if (error instanceof CodexReloginRequired) {
          await tx.execute(
            sql`select opengeni_private.fail_subscription_codex_apps_refresh(
                ${target.accountId}::uuid, ${target.workspaceId}::uuid,
                ${target.connectionId}::uuid, ${generation}::bigint, ${error.message})`,
          );
          return { kind: "relogin", message: error.message };
        }
        return { kind: "error", error };
      }
    },
  );
}

const appsRefreshFlights = new Map<string, Promise<AppsRefreshOutcome>>();

/**
 * Bearer for the designated core connection: the stored token while fresh,
 * otherwise one refresh per connection and generation in this process (the
 * advisory key serializes other replicas).
 */
export function buildSubscriptionCoreCodexAppsTokenResolver(
  db: Database,
  settings: Settings,
  target: AppsTarget,
  deps: SubscriptionCoreCodexAppsDeps = {},
): () => Promise<{ accessToken: string; chatgptAccountId: string | null }> {
  return async () => {
    const key = encryptionKey(settings);
    const credential = await loadAppsCredential(db, key, target);
    const expiry = credential.expiresAt ?? accessTokenExpiry(credential.tokens.accessToken);
    const stale = expiry
      ? expiry.getTime() <= Date.now() + CODEX_REFRESH_WINDOW_MS
      : credential.lastRefreshAt
        ? credential.lastRefreshAt.getTime() < Date.now() - CODEX_REFRESH_FALLBACK_MS
        : true;
    if (!stale) {
      return {
        accessToken: credential.tokens.accessToken,
        chatgptAccountId: credential.chatgptAccountId,
      };
    }
    const flightKey = `${target.connectionId}:${credential.refreshGeneration}`;
    let flight = appsRefreshFlights.get(flightKey);
    if (!flight) {
      flight = refreshAppsCredential(db, key, target, credential.refreshGeneration, deps).finally(
        () => appsRefreshFlights.delete(flightKey),
      );
      appsRefreshFlights.set(flightKey, flight);
    }
    const outcome = await flight;
    switch (outcome.kind) {
      case "refreshed":
        return { accessToken: outcome.accessToken, chatgptAccountId: credential.chatgptAccountId };
      case "superseded": {
        const reloaded = await loadAppsCredential(db, key, target);
        return {
          accessToken: reloaded.tokens.accessToken,
          chatgptAccountId: reloaded.chatgptAccountId,
        };
      }
      case "relogin":
        throw new CodexReloginRequired(outcome.message);
      case "unavailable":
        throw new SubscriptionCoreCodexAppsUnavailableError();
      default:
        throw outcome.error;
    }
  };
}

export type SubscriptionCoreCodexAppsRequestAuth = {
  clientVersion: string;
  withAuthorization: <T>(
    use: (token: { accessToken: string; chatgptAccountId: string | null }) => Promise<T>,
  ) => Promise<T>;
};

/**
 * Runtime Apps authentication for one core designation: resolve (and
 * refresh) the bearer, then recheck under the designation lock that the
 * workspace still designates exactly this active connection while `use` runs.
 * Every failure that means the designation cannot be used is a
 * `CodexAppsCredentialUnavailable` (or `CodexReloginRequired`).
 */
export function subscriptionCoreCodexAppsRequestAuth(
  db: Database,
  settings: Settings,
  target: AppsTarget,
  deps: SubscriptionCoreCodexAppsDeps = {},
): SubscriptionCoreCodexAppsRequestAuth {
  const resolve = buildSubscriptionCoreCodexAppsTokenResolver(db, settings, target, deps);
  return {
    clientVersion: CODEX_CLIENT_VERSION,
    withAuthorization: async (use) => {
      const token = await resolve();
      return await withRlsContext(
        db,
        { accountId: target.accountId, workspaceId: target.workspaceId },
        async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`codex-apps-settings:${target.workspaceId}`}, 0))`,
          );
          const [current] = await rawRows<{ connection_id: string; status: string }>(
            tx,
            sql`select connection_id::text as connection_id, status
              from opengeni_private.resolve_subscription_codex_apps_designation(
                ${target.accountId}::uuid, ${target.workspaceId}::uuid)`,
          );
          if (current?.connection_id !== target.connectionId) {
            throw new SubscriptionCoreCodexAppsUnavailableError();
          }
          if (current.status !== "active") {
            throw new CodexReloginRequired(
              "The designated Codex Apps account must be reconnected.",
            );
          }
          return await use(token);
        },
      );
    },
  };
}
