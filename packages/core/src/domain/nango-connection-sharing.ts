import type { Settings } from "@opengeni/config";
import {
  NANGO_ORPHAN_MIN_AGE_MS,
  NANGO_TAG,
  NangoClient,
  type NangoConnectionCredential,
  type NangoConnectionSummary,
} from "@opengeni/capabilities";
import {
  assertOrganizationIntegrationAllowed,
  NANGO_DEPLOYMENT_TAG,
  nangoDeploymentTag,
  type ConnectionMetadata,
} from "@opengeni/contracts";
import {
  connectionAccountIdentityKey,
  encryptEnvironmentValue,
  isConnectionAccountIdentityConflict,
  listConnectionsMetadata,
  listSelfOrganizationMemberships,
  nangoConnectionsInUse,
  nangoConnectionsInUseAvailable,
  recordNangoUsageEvent,
  updateConnection,
  withNangoPersonIntegrationLock,
  type Database,
} from "@opengeni/db";
import { readOrganizationIntegrationPolicyForServing } from "@opengeni/db/organization-integration-policy";
import { requireEnvironmentEncryption } from "./encryption-key";
import { listOwnConnectionMetadata } from "./personal-connection-delegations";

/**
 * At most one billed Nango connection per person, account and integration
 * (docs/nango.md, "One Nango connection per account").
 *
 * Nango bills every connection. A person who connects the same Google
 * account in several organizations gets one Opengeni row per organization
 * (organizations never share rows), but all of those rows stand for one
 * Nango connection: the newest verified one. A Nango connection is deleted
 * only when no live row of that person stands for it any more, and a sweep
 * deletes what nothing stands for (abandoned connects, rows removed by SQL
 * cascades, failed deletions) and connections Nango can no longer refresh.
 *
 * Every decision reads the authoritative `connections` rows of the person in
 * each organization they are an active member of, under a deployment-wide
 * lock per person and integration, so concurrent connects, disconnects and
 * sweeps converge. When any organization cannot be read, nothing is deleted.
 */

export type NangoSharingDeps = {
  db: Database;
  settings: Settings;
  fetchImpl?: typeof fetch;
};

/** A row that stood for a Nango connection for this long in needs_reauth is not coming back. */
export const NANGO_BROKEN_CONNECTION_GRACE_MS = 24 * 60 * 60 * 1000;
/** Nango tag values are clipped to this length; a clipped subject is never acted on. */
const NANGO_TAG_MAX_LENGTH = 255;

export function nangoSharingClient(deps: NangoSharingDeps): NangoClient | null {
  if (!deps.settings.nangoSecretKey) return null;
  return new NangoClient({
    secretKey: deps.settings.nangoSecretKey,
    ...(deps.settings.nangoApiBaseUrl ? { baseUrl: deps.settings.nangoApiBaseUrl } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

/** The Nango connection an Opengeni row stands for, if it is Nango-backed. */
export function nangoConnectionIdOf(connection: ConnectionMetadata): string | null {
  const id = connection.metadata.nangoConnectionId;
  return connection.metadata.integrationBackend === "nango" && typeof id === "string" && id
    ? id
    : null;
}

function providerConfigKeyOf(connection: ConnectionMetadata): string | null {
  const key = connection.metadata.nangoProviderConfigKey;
  return typeof key === "string" && key ? key : null;
}

/** The verified account a Nango row stands for (its email or label), if any. */
/**
 * The account identity key of a Nango connection: the Nango integration and
 * the verified account, with email addresses compared case-insensitively.
 */
export function nangoAccountIdentityKey(providerConfigKey: string, label: string): string {
  return connectionAccountIdentityKey(["nango", providerConfigKey, nangoAccountName(label)]);
}

/** One account, however the provider capitalized its email address. */
export function nangoAccountName(label: string): string {
  return label.includes("@") ? label.toLowerCase() : label;
}

/** The row's scopes are the app's defaults because Nango reported none. */
export function nangoScopesUnconfirmed(connection: ConnectionMetadata): boolean {
  return connection.metadata.nangoScopesUnconfirmed === true;
}

/** The row's verified account, emails compared case-insensitively. */
export function nangoAccountLabelOf(connection: ConnectionMetadata): string | null {
  for (const value of [connection.metadata.accountEmail, connection.metadata.accountLabel])
    if (typeof value === "string" && value) return nangoAccountName(value);
  return null;
}

export type PersonNangoConnections = {
  /** Live (not revoked) Nango-backed rows of the person. */
  rows: ConnectionMetadata[];
  /** False when some organization of the person could not be read in full. */
  complete: boolean;
  /**
   * True when a read failed (not merely a membership that is not active), so
   * even rows the person can normally see may be missing.
   */
  readFailed?: boolean;
};

/**
 * Every live Nango-backed row one person owns, in each organization they are
 * an active member of (read through their Personal workspace there), plus
 * the rows of `knownWorkspaceIds` (for example the workspace a Nango
 * connection's tags name).
 */
export async function listPersonNangoConnections(
  db: Database,
  input: {
    subjectId: string;
    providerConfigKey?: string;
    knownWorkspaceIds?: readonly string[];
  },
): Promise<PersonNangoConnections> {
  let complete = true;
  let readFailed = false;
  const failed = () => {
    complete = false;
    readFailed = true;
  };
  const byId = new Map<string, ConnectionMetadata>();
  const add = (rows: readonly ConnectionMetadata[]) => {
    for (const row of rows) {
      if (row.subjectId !== input.subjectId || row.status === "revoked") continue;
      if (!nangoConnectionIdOf(row)) continue;
      if (input.providerConfigKey && providerConfigKeyOf(row) !== input.providerConfigKey) continue;
      byId.set(row.id, row);
    }
  };
  let memberships: Awaited<ReturnType<typeof listSelfOrganizationMemberships>> = [];
  try {
    memberships = await listSelfOrganizationMemberships(db, input.subjectId);
  } catch {
    failed();
  }
  for (const membership of memberships) {
    // A suspended or provisioning membership may still hold rows this read
    // cannot see: without the deployment-wide check, never delete for it.
    if (membership.status !== "active") {
      complete = false;
      continue;
    }
    if (!membership.personalWorkspaceId) {
      complete = false;
      continue;
    }
    try {
      add(
        await listOwnConnectionMetadata(db, {
          accountId: membership.organizationId,
          workspaceId: membership.personalWorkspaceId,
          subjectId: input.subjectId,
          reach: "anywhere",
          includeInactive: true,
        }),
      );
    } catch {
      failed();
    }
  }
  for (const workspaceId of new Set(input.knownWorkspaceIds ?? [])) {
    try {
      add(await listConnectionsMetadata(db, workspaceId, input.subjectId));
    } catch {
      failed();
    }
  }
  return { rows: [...byId.values()], complete, readFailed };
}

function encryptedCredential(
  settings: NangoSharingDeps["settings"],
  credential: NangoConnectionCredential,
): string {
  return encryptEnvironmentValue(
    requireEnvironmentEncryption(settings),
    JSON.stringify(credential),
  );
}

/**
 * Point `rows` at `target` (inside the caller's person lock). Returns the
 * rows written. A row is left on its own connection (which then stays in
 * use) when the target's grant lacks a scope the row has, so no organization
 * loses access, or when its organization no longer allows the integration.
 * A row that changed meanwhile is left for the next sweep.
 */
async function repointRows(
  deps: NangoSharingDeps,
  tx: Database,
  input: {
    subjectId: string;
    rows: readonly ConnectionMetadata[];
    target: string;
    grantedScopes: readonly string[];
  },
): Promise<Array<{ before: ConnectionMetadata; after: ConnectionMetadata }>> {
  const written: Array<{ before: ConnectionMetadata; after: ConnectionMetadata }> = [];
  const allowed = new Map<string, boolean>();
  for (const row of input.rows) {
    const providerConfigKey = providerConfigKeyOf(row);
    const integrationKey = row.metadata.nangoIntegrationKey;
    const label = nangoAccountLabelOf(row);
    if (!providerConfigKey || typeof integrationKey !== "string" || !label) continue;
    if (!row.grantedScopes.every((scope) => input.grantedScopes.includes(scope))) continue;
    const policyKey = `${row.accountId}:${integrationKey}`;
    if (!allowed.has(policyKey))
      allowed.set(policyKey, await integrationAllowed(tx, row.accountId, integrationKey));
    if (!allowed.get(policyKey)) continue;
    const key = nangoAccountIdentityKey(providerConfigKey, label);
    const repoint = (keyed: boolean) =>
      // A savepoint: one row that fails leaves the others and the lock intact.
      tx.transaction(async (savepoint) =>
        updateConnection(savepoint as unknown as Database, {
          workspaceId: row.workspaceId,
          connectionId: row.id,
          visibleToSubjectId: input.subjectId,
          expectedVersion: row.version,
          subjectId: input.subjectId,
          providerDomain: row.providerDomain,
          kind: "oauth2",
          status: "active",
          credentialEncrypted: encryptedCredential(deps.settings, {
            type: "nango",
            nangoConnectionId: input.target,
            providerConfigKey,
            integrationKey,
          }),
          // Each organization keeps what was consented there; the shared
          // connection's grant covers it.
          grantedScopes: [...row.grantedScopes],
          expiresAt: null,
          metadata: { ...row.metadata, nangoConnectionId: input.target },
          // The same account: accepted work keeps using the row. A legacy
          // duplicate of a row of the same owner that already holds the key
          // shares the connection without it, so it is billed once.
          ...(keyed ? { accountIdentityKey: key, previousAccountIdentityKey: key } : {}),
          updatedBySubjectId: input.subjectId,
        }),
      );
    let after: ConnectionMetadata | null = null;
    try {
      after = await repoint(true).catch(async (error: unknown) => {
        if (!isConnectionAccountIdentityConflict(error)) throw error;
        return await repoint(false);
      });
    } catch (error) {
      console.warn("[nango] could not point a row at the shared connection; it keeps its own", {
        connectionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (after) written.push({ before: row, after });
  }
  return written;
}

/**
 * The connection one account's rows should share: the first of `preference`
 * whose grant (the scopes its rows hold, at least) covers every row's scopes,
 * so nobody loses access and nothing stays billed twice; else the first.
 */
function sharedTarget(
  preference: readonly string[],
  accountRows: readonly ConnectionMetadata[],
  extraGrant: { id: string; scopes: readonly string[] } | null = null,
): { target: string; grant: string[] } {
  const grants = new Map<string, Set<string>>();
  for (const row of accountRows) {
    const id = nangoConnectionIdOf(row);
    if (!id) continue;
    const grant = grants.get(id) ?? new Set<string>();
    // Scopes Nango never confirmed are the app's defaults, not a grant: they
    // must not move another organization's row onto this connection.
    if (!nangoScopesUnconfirmed(row)) for (const scope of row.grantedScopes) grant.add(scope);
    grants.set(id, grant);
  }
  if (extraGrant) {
    const grant = grants.get(extraGrant.id) ?? new Set<string>();
    for (const scope of extraGrant.scopes) grant.add(scope);
    grants.set(extraGrant.id, grant);
  }
  const required = new Set(accountRows.flatMap((row) => row.grantedScopes));
  const covering = preference.find((id) =>
    [...required].every((scope) => grants.get(id)?.has(scope)),
  );
  const target = covering ?? preference[0]!;
  return { target, grant: [...(grants.get(target) ?? [])] };
}

/** Whether the row's organization still allows the integration. */
async function integrationAllowed(
  tx: Database,
  accountId: string,
  integrationKey: string,
): Promise<boolean> {
  try {
    const policy = await readOrganizationIntegrationPolicyForServing(tx, { accountId });
    assertOrganizationIntegrationAllowed(policy, integrationKey);
    return true;
  } catch {
    return false;
  }
}

/** Usage events for committed repoints; call only after their transaction committed. */
function recordRepointUsage(
  deps: NangoSharingDeps,
  written: ReadonlyArray<{ before: ConnectionMetadata; after: ConnectionMetadata }>,
): void {
  for (const { before, after } of written) {
    const target = nangoConnectionIdOf(after) ?? "unknown";
    const previous = nangoConnectionIdOf(before);
    const providerConfigKey = providerConfigKeyOf(after) ?? "unknown";
    const integrationKey =
      typeof after.metadata.nangoIntegrationKey === "string"
        ? after.metadata.nangoIntegrationKey
        : "unknown";
    const event = {
      accountId: after.accountId,
      workspaceId: after.workspaceId,
      subjectId: after.subjectId,
      integrationKey,
      providerConfigKey,
      connectionId: after.id,
    };
    if (previous)
      recordNangoUsageEvent(deps.db, {
        ...event,
        nangoConnectionId: previous,
        kind: "connection_deleted",
      });
    recordNangoUsageEvent(deps.db, {
      ...event,
      nangoConnectionId: target,
      kind: "connection_reconnected",
    });
  }
}

/** Ids of `candidates` that no row in `rows` stands for. */
function unreferenced(
  candidates: Iterable<string>,
  rows: readonly ConnectionMetadata[],
): Set<string> {
  const used = new Set(rows.flatMap((row) => nangoConnectionIdOf(row) ?? []));
  return new Set([...candidates].filter((id) => !used.has(id)));
}

/**
 * The ids of `candidates` nothing stands for any more, decided under the
 * person lock: no row in `rows` (the person's reads, including writes this
 * transaction made) and, deployment-wide, no live row in any organization.
 * Until that check is granted (migration 1482) only a complete read of every
 * organization of the person may decide; otherwise nothing is unused.
 */
async function unusedNangoConnections(
  tx: Database,
  candidates: Iterable<string>,
  person: PersonNangoConnections,
): Promise<Set<string>> {
  const local = unreferenced(candidates, person.rows);
  const anywhere = await nangoConnectionsInUse(tx, [...local]);
  if (anywhere === null) return person.complete ? local : new Set();
  return new Set([...local].filter((id) => !anywhere.has(id)));
}

/** The ids Nango reports as created less than a connect attempt's lifetime ago. */
async function madeWithinAttempt(
  client: NangoClient,
  ids: Iterable<string>,
  now: number,
): Promise<Set<string>> {
  const fresh = new Set<string>();
  for (const id of ids) {
    const [summary] = await client.listConnections({ connectionId: id }).catch(() => []);
    const created = summary?.createdAt ? Date.parse(summary.createdAt) : Number.NaN;
    if (Number.isFinite(created) && now - created < NANGO_ORPHAN_MIN_AGE_MS) fresh.add(id);
  }
  return fresh;
}

/**
 * Delete in Nango, holding the person lock so no connect can start standing
 * for one meanwhile. A failed delete is logged and left for the sweep.
 */
async function deleteInNango(
  client: NangoClient,
  ids: Iterable<string>,
  providerConfigKey: string,
): Promise<string[]> {
  const deleted: string[] = [];
  for (const id of ids) {
    try {
      await client.deleteConnection(id, providerConfigKey);
      deleted.push(id);
    } catch (error) {
      // The sweep deletes it later if it carries this deployment's tag;
      // an untagged one needs `integrations:nango orphans`.
      console.warn("[nango] connection deletion failed; the sweep retries tagged connections", {
        nangoConnectionId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return deleted;
}

export type NangoShareResult = {
  /** Another connect of the same account won meanwhile; nothing was changed. */
  superseded: boolean;
  /** Rows in any organization now pointed at the shared connection. */
  repointed: ConnectionMetadata[];
  /** Nango connections nothing stands for any more, deleted in Nango. */
  deleted: string[];
};

/**
 * Make one verified, just-stored Nango connection the only one behind the
 * person's account: every live row of this person, integration and account
 * (in any organization) is pointed at `nangoConnectionId`, and the Nango
 * connections they stood for are deleted once nothing stands for them.
 * Rows without a verified account are never merged.
 */
export async function shareNangoConnection(
  deps: NangoSharingDeps,
  input: {
    subjectId: string;
    providerConfigKey: string;
    accountLabel: string | null;
    nangoConnectionId: string;
    grantedScopes: readonly string[];
    knownWorkspaceIds?: readonly string[];
  },
): Promise<NangoShareResult> {
  const none: NangoShareResult = { superseded: false, repointed: [], deleted: [] };
  const client = nangoSharingClient(deps);
  if (!client) return none;
  const stored = input.nangoConnectionId;
  const plan = await withNangoPersonIntegrationLock(deps.db, input, async (tx) => {
    const person = await listPersonNangoConnections(tx, input);
    const nothing = { written: [], release: [] as string[] };
    if (!person.rows.some((row) => nangoConnectionIdOf(row) === stored))
      return { superseded: true, ...nothing };
    if (!input.accountLabel) return { superseded: false, ...nothing };
    const accountRows = person.rows.filter(
      (row) => nangoAccountLabelOf(row) === input.accountLabel,
    );
    // The new connection, unless a healthy one of the same account already
    // covers every grant (a narrower connect elsewhere): then that one.
    const healthy = (id: string) => {
      const standing = accountRows.filter((row) => nangoConnectionIdOf(row) === id);
      return standing.length > 0 && standing.every((row) => row.status === "active");
    };
    const existing = [
      ...new Set(
        [...accountRows]
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .flatMap((row) => nangoConnectionIdOf(row) ?? []),
      ),
    ].filter((id) => id !== stored && healthy(id));
    // Only one Nango still reports without auth errors may replace a fresh
    // reconnect; otherwise the stored connection stays the target.
    const confirmed: string[] = [];
    for (const id of existing) {
      const [summary] = await client.listConnections({ connectionId: id }).catch(() => []);
      if (summary && summary.authErrors === 0) confirmed.push(id);
    }
    // A grant Nango did not report (the app's defaults) covers nobody else.
    const storedConfirmed = !accountRows.some(
      (row) => nangoConnectionIdOf(row) === stored && nangoScopesUnconfirmed(row),
    );
    const { target, grant } = sharedTarget(
      [stored, ...confirmed],
      accountRows,
      storedConfirmed ? { id: stored, scopes: input.grantedScopes } : null,
    );
    const others = accountRows.filter((row) => nangoConnectionIdOf(row) !== target);
    const written = await repointRows(deps, tx, {
      subjectId: input.subjectId,
      rows: others,
      target,
      grantedScopes: grant,
    });
    const after = person.rows.map(
      (row) => written.find((entry) => entry.before.id === row.id)?.after ?? row,
    );
    const previous = new Set(others.flatMap((row) => nangoConnectionIdOf(row) ?? []));
    const release = await unusedNangoConnections(tx, previous, { ...person, rows: after });
    return { superseded: false, written, release: [...release] };
  });
  // Committed: the repointed rows now stand for the shared connection.
  recordRepointUsage(deps, plan.written);
  return {
    superseded: plan.superseded,
    repointed: plan.written.map((entry) => entry.after),
    deleted: await releaseCommitted(deps, input, plan.release),
  };
}

/**
 * Delete connections a committed repoint left unused. Deleting before the
 * commit could leave rows on a deleted connection if the commit failed, so
 * this checks again under the person lock, in a transaction that writes
 * nothing, and deletes there.
 */
async function releaseCommitted(
  deps: NangoSharingDeps,
  input: { subjectId: string; providerConfigKey: string; knownWorkspaceIds?: readonly string[] },
  nangoConnectionIds: readonly string[],
): Promise<string[]> {
  if (nangoConnectionIds.length === 0) return [];
  return (
    await releaseNangoConnections(deps, {
      subjectId: input.subjectId,
      providerConfigKey: input.providerConfigKey,
      nangoConnectionIds,
      ...(input.knownWorkspaceIds ? { knownWorkspaceIds: input.knownWorkspaceIds } : {}),
    })
  ).deleted;
}

/**
 * Delete these Nango connections of one person in Nango unless some live row
 * of theirs, in any organization, still stands for one. Used after a
 * disconnect, a reconnect that replaced a connection, and a refused connect.
 */
export async function releaseNangoConnections(
  deps: NangoSharingDeps,
  input: {
    subjectId: string;
    providerConfigKey: string;
    nangoConnectionIds: readonly string[];
    knownWorkspaceIds?: readonly string[];
    /**
     * The connections were made by a connect attempt that is now refused or
     * failed. Only a store from that attempt (readable here) or a share
     * after it can name one, so while the deployment-wide check is withheld
     * an incomplete read still releases one no readable row names, if Nango
     * made it within a connect attempt's lifetime.
     */
    freshAttempt?: boolean;
    now?: number;
  },
): Promise<{ deleted: string[]; kept: string[] }> {
  const client = nangoSharingClient(deps);
  if (!client || input.nangoConnectionIds.length === 0)
    return { deleted: [], kept: [...input.nangoConnectionIds] };
  const deleted = await withNangoPersonIntegrationLock(deps.db, input, async (tx) => {
    const person = await listPersonNangoConnections(tx, input);
    let release = await unusedNangoConnections(tx, input.nangoConnectionIds, person);
    if (
      input.freshAttempt &&
      !person.complete &&
      !person.readFailed &&
      release.size === 0 &&
      !(await nangoConnectionsInUseAvailable(tx))
    )
      release = await madeWithinAttempt(
        client,
        unreferenced(input.nangoConnectionIds, person.rows),
        input.now ?? Date.now(),
      );
    return await deleteInNango(client, release, input.providerConfigKey);
  });
  return {
    deleted,
    kept: input.nangoConnectionIds.filter((id) => !deleted.includes(id)),
  };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export type NangoSweepResult = {
  listed: number;
  /** Unused Nango connections Opengeni made, deleted. */
  deletedOrphans: string[];
  /** Duplicate connections of one account, deleted after their rows were shared. */
  deletedDuplicates: string[];
  /** Connections Nango could not refresh for the grace period, deleted. */
  deletedBroken: string[];
  repointed: number;
  /** People whose organizations could not all be read: nothing of theirs was deleted. */
  skippedPeople: number;
  /** Too many orphans at once to trust; none were deleted. */
  orphanBreakerTripped: boolean;
  /** The pass ran out of time; the people left wait for the next pass. */
  deferredPeople: number;
};

type SweepGroup = {
  subjectId: string;
  providerConfigKey: string;
  remote: NangoConnectionSummary[];
};

export type NangoSweepOptions = {
  now?: number;
  minAgeMs?: number;
  brokenGraceMs?: number;
  /** Stop starting people after this many milliseconds (default 3 minutes). */
  budgetMs?: number;
  /** Called between people, for example to heartbeat an activity. */
  onProgress?: () => void;
  /** Wall clock for the budget; tests pass their own. */
  clock?: () => number;
};

/** A pass stops starting new people after this long, well inside its activity timeout. */
export const NANGO_SWEEP_BUDGET_MS = 3 * 60 * 1000;

/**
 * The automatic cleanup: lists every Nango connection, and for each person
 * and integration among the ones this deployment made (attempt- and
 * deployment-tagged), holding that person's lock:
 *
 * - shares duplicate connections of one verified account (rows left by an
 *   older release or a failed share) and deletes the extra ones;
 * - deletes connections no live row stands for, at least `minAgeMs` old
 *   (abandoned or refused connects, rows removed by SQL cascades, failed
 *   deletions); more than half of them at once trips a breaker instead;
 * - deletes connections whose rows have all needed reconnection because
 *   Nango could not refresh them for `brokenGraceMs`, while Nango still
 *   reports the failure. Their rows keep asking to reconnect.
 *
 * Connections without this deployment's tag (made outside Opengeni, by
 * another deployment sharing the Nango environment, or before the tag) are
 * left to the operator. People are visited in random order within a time
 * budget, so a large environment is covered over several passes.
 */
export async function sweepNangoConnections(
  deps: NangoSharingDeps,
  options: NangoSweepOptions = {},
): Promise<NangoSweepResult | null> {
  const client = nangoSharingClient(deps);
  if (!client) return null;
  const deployment = nangoDeploymentTag(deps.settings);
  if (!deployment) {
    console.warn("[nango] sweep skipped: no public base URL names this deployment's connections");
    return null;
  }
  const clock = options.clock ?? Date.now;
  const started = clock();
  const now = options.now ?? started;
  const budgetMs = options.budgetMs ?? NANGO_SWEEP_BUDGET_MS;
  const minAgeMs = Math.max(options.minAgeMs ?? NANGO_ORPHAN_MIN_AGE_MS, NANGO_ORPHAN_MIN_AGE_MS);
  const brokenGraceMs = options.brokenGraceMs ?? NANGO_BROKEN_CONNECTION_GRACE_MS;
  const planOptions = { now, minAgeMs, brokenGraceMs };
  const remote = await client.listAllConnections();
  const groups = new Map<string, SweepGroup>();
  for (const connection of remote) {
    const subjectId = connection.tags[NANGO_TAG.endUserId];
    if (!connection.tags[NANGO_TAG.attemptId] || !subjectId) continue;
    if (connection.tags[NANGO_DEPLOYMENT_TAG] !== deployment) continue;
    const key = JSON.stringify([subjectId, connection.providerConfigKey]);
    let group = groups.get(key);
    if (!group) {
      group = { subjectId, providerConfigKey: connection.providerConfigKey, remote: [] };
      groups.set(key, group);
    }
    group.remote.push(connection);
  }
  const result: NangoSweepResult = {
    listed: remote.length,
    deletedOrphans: [],
    deletedDuplicates: [],
    deletedBroken: [],
    repointed: 0,
    skippedPeople: 0,
    orphanBreakerTripped: false,
    deferredPeople: 0,
  };
  const order = shuffled([...groups.values()]);
  const tagged = order.reduce((sum, group) => sum + group.remote.length, 0);
  const withOrphans: SweepGroup[] = [];
  let orphanCount = 0;
  const outOfTime = () => clock() - started >= budgetMs;
  for (const [index, group] of order.entries()) {
    if (outOfTime()) {
      result.deferredPeople = order.length - index;
      break;
    }
    options.onProgress?.();
    if (group.subjectId.length >= NANGO_TAG_MAX_LENGTH) {
      result.skippedPeople += 1;
      continue;
    }
    try {
      const outcome = await withNangoPersonIntegrationLock(deps.db, group, async (tx) => {
        const plan = await planGroup(deps, tx, group, planOptions);
        if (!plan) return null;
        // Broken connections are the ones rows still stand for, unmoved, so
        // a failed commit changes nothing about them.
        return {
          ...plan,
          deletedBroken: await deleteInNango(client, plan.broken, group.providerConfigKey),
        };
      });
      if (!outcome) {
        result.skippedPeople += 1;
        continue;
      }
      recordRepointUsage(deps, outcome.written);
      result.repointed += outcome.written.length;
      // Duplicates are deleted only once their rows' repoint is committed; a
      // failure here keeps what this person's pass already did.
      result.deletedDuplicates.push(
        ...(await releaseCommitted(
          deps,
          {
            subjectId: group.subjectId,
            providerConfigKey: group.providerConfigKey,
            knownWorkspaceIds: group.remote.flatMap(
              (connection) => connection.tags[NANGO_TAG.workspaceId] ?? [],
            ),
          },
          outcome.duplicates,
        ).catch((error: unknown) => {
          console.warn("[nango] sweep kept one person's replaced connections", {
            error: error instanceof Error ? error.message : String(error),
          });
          return [] as string[];
        })),
      );
      result.deletedBroken.push(...outcome.deletedBroken);
      if (outcome.orphans.length) {
        withOrphans.push(group);
        orphanCount += outcome.orphans.length;
      }
    } catch (error) {
      console.warn("[nango] sweep skipped one person", {
        error: error instanceof Error ? error.message : String(error),
      });
      result.skippedPeople += 1;
    }
  }
  if (result.skippedPeople > 0)
    console.warn("[nango] sweep could not decide for some people; their connections were kept", {
      skippedPeople: result.skippedPeople,
    });
  // A broken read must never delete everyone's connections.
  if (orphanCount > Math.max(10, Math.floor(tagged / 2))) {
    result.orphanBreakerTripped = true;
    console.warn("[nango] sweep found too many unused connections; none deleted", {
      orphans: orphanCount,
      tagged,
    });
    return result;
  }
  // Each person's orphans are checked again under their lock before deletion.
  for (const group of withOrphans) {
    if (outOfTime()) {
      result.deferredPeople += 1;
      continue;
    }
    options.onProgress?.();
    try {
      result.deletedOrphans.push(
        ...(await withNangoPersonIntegrationLock(deps.db, group, async (tx) => {
          const plan = await planGroup(deps, tx, group, planOptions, { orphansOnly: true });
          return plan ? await deleteInNango(client, plan.orphans, group.providerConfigKey) : [];
        })),
      );
    } catch (error) {
      console.warn("[nango] sweep kept one person's unused connections", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

function shuffled<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [items[index], items[other]] = [items[other]!, items[index]!];
  }
  return items;
}

async function planGroup(
  deps: NangoSharingDeps,
  tx: Database,
  group: SweepGroup,
  options: { now: number; minAgeMs: number; brokenGraceMs: number },
  mode: { orphansOnly?: boolean } = {},
): Promise<{
  written: Array<{ before: ConnectionMetadata; after: ConnectionMetadata }>;
  duplicates: string[];
  broken: string[];
  orphans: string[];
} | null> {
  const knownWorkspaceIds = group.remote.flatMap(
    (connection) => connection.tags[NANGO_TAG.workspaceId] ?? [],
  );
  const person = await listPersonNangoConnections(tx, {
    subjectId: group.subjectId,
    providerConfigKey: group.providerConfigKey,
    knownWorkspaceIds,
  });
  // Without the deployment-wide check, only a complete read may decide.
  if (!person.complete && !(await nangoConnectionsInUseAvailable(tx))) return null;
  const remoteById = new Map(
    group.remote.map((connection) => [connection.connectionId, connection]),
  );
  const created = (id: string) => {
    const value = remoteById.get(id)?.createdAt;
    const time = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
  };
  let rows = person.rows;
  const written: Array<{ before: ConnectionMetadata; after: ConnectionMetadata }> = [];
  const duplicates = new Set<string>();
  if (!mode.orphansOnly) {
    // 1. Duplicates: one verified account standing for several connections.
    const byAccount = new Map<string, ConnectionMetadata[]>();
    for (const row of rows) {
      const label = nangoAccountLabelOf(row);
      if (label) byAccount.set(label, [...(byAccount.get(label) ?? []), row]);
    }
    for (const accountRows of byAccount.values()) {
      const ids = [...new Set(accountRows.flatMap((row) => nangoConnectionIdOf(row) ?? []))];
      // Only a healthy connection Nango still has can stand for the others.
      const healthy = ids.filter((id) => (remoteById.get(id)?.authErrors ?? 1) === 0);
      if (ids.length < 2 || healthy.length === 0) continue;
      const { target, grant } = sharedTarget(
        healthy.sort((a, b) => created(b) - created(a) || a.localeCompare(b)),
        accountRows,
      );
      const repointed = await repointRows(deps, tx, {
        subjectId: group.subjectId,
        rows: accountRows.filter((row) => nangoConnectionIdOf(row) !== target),
        target,
        grantedScopes: grant,
      });
      written.push(...repointed);
      rows = rows.map((row) => repointed.find((entry) => entry.before.id === row.id)?.after ?? row);
      for (const id of await unusedNangoConnections(
        tx,
        ids.filter((candidate) => candidate !== target),
        { ...person, rows },
      ))
        duplicates.add(id);
    }
  }
  // 2. Orphans: Opengeni made them, nothing stands for them, past any connect.
  const old = group.remote
    .filter((connection) => !duplicates.has(connection.connectionId))
    .filter((connection) => {
      const time = connection.createdAt ? Date.parse(connection.createdAt) : Number.NaN;
      return Number.isFinite(time) && options.now - time >= options.minAgeMs;
    })
    .map((connection) => connection.connectionId);
  const orphans = [...(await unusedNangoConnections(tx, old, { ...person, rows }))];
  // 3. Broken: every row asks to reconnect because Nango could not refresh it.
  const used = new Set(rows.flatMap((row) => nangoConnectionIdOf(row) ?? []));
  const broken = mode.orphansOnly
    ? []
    : [...used].filter((id) => {
        if ((remoteById.get(id)?.authErrors ?? 0) === 0) return false;
        const standing = rows.filter((row) => nangoConnectionIdOf(row) === id);
        return (
          person.complete &&
          standing.every(
            (row) =>
              row.status === "needs_reauth" &&
              row.lastError === "nango_refresh_failed" &&
              options.now - Date.parse(row.updatedAt) >= options.brokenGraceMs,
          )
        );
      });
  return { written, duplicates: [...duplicates], broken, orphans };
}
