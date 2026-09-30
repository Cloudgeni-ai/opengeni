import { timingSafeEqual } from "node:crypto";
import {
  ClaudeSubscriptionCredential,
  emptyClaudeUsage,
  environmentsEncryptionKeyBytes,
  mergeClaudeUsage,
  type ClaudeUsageObservation,
  type Settings,
} from "@opengeni/config";
import { ClaudeSubscriptionUsage } from "@opengeni/contracts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { type Database, setSubjectRlsContext, withRlsContext } from "./database";
import { decryptEnvironmentValue } from "./environment-crypto";
import { connections, organizationModelProviderConnections } from "./schema";

export type ClaudeUsageScope = {
  accountId: string;
  workspaceId: string | null;
  scope: "workspace" | "organization";
  actorSubjectId?: string;
};

async function scoped<T>(
  db: Database,
  scope: ClaudeUsageScope,
  use: (db: Database) => Promise<T>,
): Promise<T> {
  if (scope.scope === "workspace" && !scope.workspaceId)
    throw new Error("Claude workspace is required");
  return withRlsContext(db, scope, async (tx) => {
    if (scope.actorSubjectId) await setSubjectRlsContext(tx, scope.actorSubjectId);
    if (scope.scope === "organization" && !scope.workspaceId) {
      if (!scope.actorSubjectId) throw new Error("Claude organization administrator is required");
      await tx.execute(
        sql`select get_organization_administration_overview(${scope.accountId}::uuid, ${scope.actorSubjectId})`,
      );
    }
    return use(tx);
  });
}

async function connection(db: Database, scope: ClaudeUsageScope, lock = false) {
  if (scope.scope === "workspace") {
    const query = db
      .select({
        id: connections.id,
        version: connections.version,
        credentialEncrypted: connections.credentialEncrypted,
        updatedAt: connections.updatedAt,
        snapshot: connections.claudeUsageSnapshot,
      })
      .from(connections)
      .where(
        and(
          eq(connections.accountId, scope.accountId),
          eq(connections.workspaceId, scope.workspaceId!),
          isNull(connections.subjectId),
          eq(connections.providerDomain, "api.anthropic.com"),
          eq(connections.kind, "api_key"),
          eq(connections.status, "active"),
          sql`${connections.metadata}->>'credentialRole' = 'claude_subscription'`,
        ),
      )
      .orderBy(desc(connections.updatedAt), desc(connections.id))
      .limit(1);
    return (await (lock ? query.for("update") : query))[0] ?? null;
  }
  const table = organizationModelProviderConnections;
  const query = db
    .select({
      id: table.id,
      version: table.version,
      credentialEncrypted: table.credentialEncrypted,
      updatedAt: table.updatedAt,
      snapshot: table.claudeUsageSnapshot,
    })
    .from(table)
    .where(
      and(
        eq(table.accountId, scope.accountId),
        eq(table.providerKind, "claude_subscription"),
        eq(table.status, "active"),
      ),
    )
    .limit(1);
  return (await (lock ? query.for("update") : query))[0] ?? null;
}

function usage(row: Awaited<ReturnType<typeof connection>>) {
  if (!row) return emptyClaudeUsage(null);
  const parsed = ClaudeSubscriptionUsage.safeParse(row.snapshot);
  return parsed.success && parsed.data.credentialVersion === row.version
    ? parsed.data
    : emptyClaudeUsage(row.version);
}
function token(
  settings: Settings,
  scope: ClaudeUsageScope,
  row: NonNullable<Awaited<ReturnType<typeof connection>>>,
) {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) throw new Error("Claude credential encryption is unavailable");
  let plaintext = decryptEnvironmentValue(key, row.credentialEncrypted);
  if (scope.scope === "workspace") {
    const credential = JSON.parse(plaintext) as { apiKey?: unknown };
    if (typeof credential.apiKey !== "string") throw new Error("Claude credential is invalid");
    plaintext = credential.apiKey;
  }
  return plaintext.startsWith("{")
    ? ClaudeSubscriptionCredential.parse(JSON.parse(plaintext)).token
    : plaintext;
}
function sameToken(left: string, right: string) {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function readClaudeSubscriptionUsage(db: Database, scope: ClaudeUsageScope) {
  return scoped(db, scope, async (tx) => usage(await connection(tx, scope)));
}

/** Secret accessor for authorized refreshes and worker response-observation binding. */
export async function loadClaudeSubscriptionUsageCredential(
  db: Database,
  settings: Settings,
  scope: ClaudeUsageScope,
) {
  return scoped(db, scope, async (tx) => {
    const row = await connection(tx, scope);
    return row
      ? {
          connectionId: row.id,
          credentialVersion: row.version,
          token: token(settings, scope, row),
          usage: usage(row),
        }
      : null;
  });
}

/** Telemetry never changes credential/admission versions or connection timestamps. */
export async function recordClaudeSubscriptionUsage(
  db: Database,
  settings: Settings,
  scope: ClaudeUsageScope,
  input: {
    token: string;
    observation?: ClaudeUsageObservation;
    refresh?: { status: ClaudeSubscriptionUsage["refreshStatus"]; checkedAt: string };
    expectedConnectionId?: string;
    expectedCredentialVersion?: number;
  },
) {
  return scoped(db, scope, async (tx) => {
    const row = await connection(tx, scope, true);
    if (
      !row ||
      (input.expectedConnectionId && row.id !== input.expectedConnectionId) ||
      (input.expectedCredentialVersion !== undefined &&
        row.version !== input.expectedCredentialVersion) ||
      !sameToken(token(settings, scope, row), input.token)
    )
      return null;
    // A late response from before replacement must not reanimate the old cache.
    if (input.observation && Date.parse(input.observation.observedAt) < row.updatedAt.getTime())
      return null;
    let snapshot = usage(row);
    if (input.observation) snapshot = mergeClaudeUsage(snapshot, input.observation);
    if (
      input.refresh &&
      (!snapshot.refreshCheckedAt || snapshot.refreshCheckedAt <= input.refresh.checkedAt)
    )
      snapshot = {
        ...snapshot,
        refreshStatus: input.refresh.status,
        refreshCheckedAt: input.refresh.checkedAt,
      };
    snapshot = ClaudeSubscriptionUsage.parse(snapshot);
    if (scope.scope === "workspace")
      await tx
        .update(connections)
        .set({ claudeUsageSnapshot: snapshot })
        .where(eq(connections.id, row.id));
    else
      await tx
        .update(organizationModelProviderConnections)
        .set({ claudeUsageSnapshot: snapshot })
        .where(eq(organizationModelProviderConnections.id, row.id));
    return snapshot;
  });
}
