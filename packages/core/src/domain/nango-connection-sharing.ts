import type { Settings } from "@opengeni/config";
import {
  NANGO_ORPHAN_MIN_AGE_MS,
  NANGO_TAG,
  NangoClient,
  type NangoConnectionCredential,
  type NangoConnectionSummary,
} from "@opengeni/capabilities";
import type { ConnectionMetadata } from "@opengeni/contracts";
import {
  encryptEnvironmentValue,
  listConnectionsMetadata,
  listSelfOrganizationMemberships,
  recordNangoUsageEvent,
  updateConnection,
  withNangoPersonIntegrationLock,
  type Database,
} from "@opengeni/db";
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
export function nangoAccountLabelOf(connection: ConnectionMetadata): string | null {
  for (const value of [connection.metadata.accountEmail, connection.metadata.accountLabel])
    if (typeof value === "string" && value) return value;
  return null;
}

export type PersonNangoConnections = {
  /** Live (not revoked) Nango-backed rows of the person. */
  rows: ConnectionMetadata[];
  /** False when some organization of the person could not be read. */
  complete: boolean;
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
    complete = false;
  }
  for (const membership of memberships) {
    if (membership.status !== "active") continue;
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
      complete = false;
    }
  }
  for (const workspaceId of new Set(input.knownWorkspaceIds ?? [])) {
    try {
      add(await listConnectionsMetadata(db, workspaceId, input.subjectId));
    } catch {
      complete = false;
    }
  }
  return { rows: [...byId.values()], complete };
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
 * rows written; a row that changed meanwhile is left for the next sweep.
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
  for (const row of input.rows) {
    const providerConfigKey = providerConfigKeyOf(row);
    const integrationKey = row.metadata.nangoIntegrationKey;
    if (!providerConfigKey || typeof integrationKey !== "string") continue;
    const after = await updateConnection(tx, {
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
      grantedScopes: [...input.grantedScopes],
      expiresAt: null,
      metadata: { ...row.metadata, nangoConnectionId: input.target },
      updatedBySubjectId: input.subjectId,
    }).catch(() => null);
    if (after) written.push({ before: row, after });
  }
  return written;
}

function recordRepointUsage(
  deps: NangoSharingDeps,
  written: ReadonlyArray<{ before: ConnectionMetadata; after: ConnectionMetadata }>,
  target: string,
): void {
  for (const { before, after } of written) {
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
      // The sweep deletes it later: nothing stands for it any more.
      console.warn("[nango] connection deletion failed; the sweep retries it", {
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
  const target = input.nangoConnectionId;
  const plan = await withNangoPersonIntegrationLock(deps.db, input, async (tx) => {
    const person = await listPersonNangoConnections(tx, input);
    if (!person.rows.some((row) => nangoConnectionIdOf(row) === target))
      return { superseded: true, written: [], release: new Set<string>() };
    if (!input.accountLabel) return { superseded: false, written: [], release: new Set<string>() };
    const others = person.rows.filter(
      (row) =>
        nangoAccountLabelOf(row) === input.accountLabel && nangoConnectionIdOf(row) !== target,
    );
    const written = await repointRows(deps, tx, {
      subjectId: input.subjectId,
      rows: others,
      target,
      grantedScopes: input.grantedScopes,
    });
    const after = person.rows.map(
      (row) => written.find((entry) => entry.before.id === row.id)?.after ?? row,
    );
    const previous = new Set(others.flatMap((row) => nangoConnectionIdOf(row) ?? []));
    // An organization we could not read may still stand for one of them.
    return {
      superseded: false,
      written,
      release: person.complete ? unreferenced(previous, after) : new Set<string>(),
    };
  });
  recordRepointUsage(deps, plan.written, target);
  return {
    superseded: plan.superseded,
    repointed: plan.written.map((entry) => entry.after),
    deleted: await deleteInNango(client, plan.release, input.providerConfigKey),
  };
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
  },
): Promise<{ deleted: string[]; kept: string[] }> {
  const client = nangoSharingClient(deps);
  if (!client || input.nangoConnectionIds.length === 0)
    return { deleted: [], kept: [...input.nangoConnectionIds] };
  const release = await withNangoPersonIntegrationLock(deps.db, input, async (tx) => {
    const person = await listPersonNangoConnections(tx, input);
    return person.complete
      ? unreferenced(input.nangoConnectionIds, person.rows)
      : new Set<string>();
  });
  const deleted = await deleteInNango(client, release, input.providerConfigKey);
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
};

type SweepGroup = {
  subjectId: string;
  providerConfigKey: string;
  remote: NangoConnectionSummary[];
};

/**
 * The automatic cleanup: lists every Nango connection, and for each person
 * and integration among the ones Opengeni made (attempt-tagged):
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
 * Untagged connections (made outside Opengeni) are left to the operator.
 */
export async function sweepNangoConnections(
  deps: NangoSharingDeps,
  options: { now?: number; minAgeMs?: number; brokenGraceMs?: number } = {},
): Promise<NangoSweepResult | null> {
  const client = nangoSharingClient(deps);
  if (!client) return null;
  const now = options.now ?? Date.now();
  const minAgeMs = Math.max(options.minAgeMs ?? NANGO_ORPHAN_MIN_AGE_MS, NANGO_ORPHAN_MIN_AGE_MS);
  const brokenGraceMs = options.brokenGraceMs ?? NANGO_BROKEN_CONNECTION_GRACE_MS;
  const remote = await client.listAllConnections();
  const groups = new Map<string, SweepGroup>();
  for (const connection of remote) {
    const subjectId = connection.tags[NANGO_TAG.endUserId];
    if (!connection.tags[NANGO_TAG.attemptId] || !subjectId) continue;
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
  };
  const orphans: Array<{ id: string; providerConfigKey: string }> = [];
  let tagged = 0;
  for (const group of groups.values()) {
    tagged += group.remote.length;
    if (group.subjectId.length >= NANGO_TAG_MAX_LENGTH) {
      result.skippedPeople += 1;
      continue;
    }
    let plan: Awaited<ReturnType<typeof planGroup>>;
    try {
      plan = await withNangoPersonIntegrationLock(deps.db, group, (tx) =>
        planGroup(deps, tx, group, { now, minAgeMs, brokenGraceMs }),
      );
    } catch (error) {
      console.warn("[nango] sweep skipped one person", {
        error: error instanceof Error ? error.message : String(error),
      });
      result.skippedPeople += 1;
      continue;
    }
    if (!plan) {
      result.skippedPeople += 1;
      continue;
    }
    result.repointed += plan.repointed;
    result.deletedDuplicates.push(
      ...(await deleteInNango(client, plan.duplicates, group.providerConfigKey)),
    );
    result.deletedBroken.push(
      ...(await deleteInNango(client, plan.broken, group.providerConfigKey)),
    );
    for (const id of plan.orphans) orphans.push({ id, providerConfigKey: group.providerConfigKey });
  }
  // A broken read must never delete everyone's connections.
  if (orphans.length > Math.max(10, Math.floor(tagged / 2))) {
    result.orphanBreakerTripped = true;
    console.warn("[nango] sweep found too many unused connections; none deleted", {
      orphans: orphans.length,
      tagged,
    });
    return result;
  }
  for (const orphan of orphans)
    result.deletedOrphans.push(
      ...(await deleteInNango(client, [orphan.id], orphan.providerConfigKey)),
    );
  return result;
}

async function planGroup(
  deps: NangoSharingDeps,
  tx: Database,
  group: SweepGroup,
  options: { now: number; minAgeMs: number; brokenGraceMs: number },
): Promise<{
  repointed: number;
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
  if (!person.complete) return null;
  const remoteById = new Map(
    group.remote.map((connection) => [connection.connectionId, connection]),
  );
  const created = (id: string) => {
    const value = remoteById.get(id)?.createdAt;
    const time = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
  };
  // 1. Duplicates: one verified account standing for several connections.
  let rows = person.rows;
  let repointed = 0;
  const duplicates = new Set<string>();
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
    const target = healthy.sort((a, b) => created(b) - created(a) || a.localeCompare(b))[0]!;
    const source = accountRows.find((row) => nangoConnectionIdOf(row) === target)!;
    const written = await repointRows(deps, tx, {
      subjectId: group.subjectId,
      rows: accountRows.filter((row) => nangoConnectionIdOf(row) !== target),
      target,
      grantedScopes: source.grantedScopes,
    });
    recordRepointUsage(deps, written, target);
    repointed += written.length;
    rows = rows.map((row) => written.find((entry) => entry.before.id === row.id)?.after ?? row);
    for (const id of unreferenced(
      ids.filter((candidate) => candidate !== target),
      rows,
    ))
      duplicates.add(id);
  }
  // 2. Orphans: Opengeni made them, nothing stands for them, past any connect.
  const used = new Set(rows.flatMap((row) => nangoConnectionIdOf(row) ?? []));
  const orphans = group.remote
    .filter((connection) => !used.has(connection.connectionId))
    .filter((connection) => !duplicates.has(connection.connectionId))
    .filter((connection) => {
      const time = connection.createdAt ? Date.parse(connection.createdAt) : Number.NaN;
      return Number.isFinite(time) && options.now - time >= options.minAgeMs;
    })
    .map((connection) => connection.connectionId);
  // 3. Broken: every row asks to reconnect because Nango could not refresh it.
  const broken = [...used].filter((id) => {
    if ((remoteById.get(id)?.authErrors ?? 0) === 0) return false;
    const standing = rows.filter((row) => nangoConnectionIdOf(row) === id);
    return standing.every(
      (row) =>
        row.status === "needs_reauth" &&
        row.lastError === "nango_refresh_failed" &&
        options.now - Date.parse(row.updatedAt) >= options.brokenGraceMs,
    );
  });
  return { repointed, duplicates: [...duplicates], broken, orphans };
}
