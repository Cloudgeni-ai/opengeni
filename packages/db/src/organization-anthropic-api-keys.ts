import { randomUUID } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { and, eq, sql } from "drizzle-orm";

import { type Database, withRlsContext } from "./database";
import { decryptEnvironmentValue } from "./environment-crypto";
import {
  OrganizationModelProviderConflictError,
  OrganizationModelProviderLimitError,
  withOrganizationProviderAdministrator,
} from "./organization-model-providers";
import * as schema from "./schema";
import type { StoredAnthropicApiKeyMember } from "./schema";

/**
 * An organization's Anthropic API connection can hold several API keys: its
 * own key is the first member, and the others are stored beside it. They
 * serve only the connection's `organization-anthropic/` models, never Claude
 * subscription models.
 */
export const ORGANIZATION_ANTHROPIC_API_KEY_LIMIT = 64;

/** The member id of the connection's own key, which changes when that key is replaced. */
export function organizationAnthropicConnectionKeyMemberId(connectionVersion: number): string {
  return `primary-v${connectionVersion}`;
}

export type OrganizationAnthropicApiKey = {
  id: string;
  /** Null for the connection's own key. */
  label: string | null;
  connectionKey: boolean;
  /** The Anthropic organization the key belongs to, when known. */
  anthropicOrganizationId: string | null;
  /** When Anthropic refused the key for lack of credits; null while it serves. */
  creditRefusedAt: Date | null;
  createdAt: Date;
};

export type OrganizationAnthropicApiKeys = {
  connectionVersion: number;
  keys: OrganizationAnthropicApiKey[];
};

type ConnectionRow = typeof schema.organizationModelProviderConnections.$inferSelect;

function refusalTime(row: ConnectionRow, id: string): Date | null {
  const at = row.apiKeyCreditRefusals?.[id];
  return typeof at === "string" ? new Date(at) : null;
}

function mapKeys(row: ConnectionRow): OrganizationAnthropicApiKeys {
  const primaryId = organizationAnthropicConnectionKeyMemberId(row.version);
  return {
    connectionVersion: row.version,
    keys: [
      {
        id: primaryId,
        label: null,
        connectionKey: true,
        anthropicOrganizationId: null,
        creditRefusedAt: refusalTime(row, primaryId),
        createdAt: row.updatedAt,
      },
      ...(row.apiKeyMembers ?? []).map((member) => ({
        id: member.id,
        label: member.label,
        connectionKey: false,
        anthropicOrganizationId: member.anthropicOrganizationId,
        creditRefusedAt: refusalTime(row, member.id),
        createdAt: new Date(member.createdAt),
      })),
    ],
  };
}

/**
 * The keys a request may send, as `[{id, credentialEncrypted}]` with the
 * connection's own key first, leaving out keys refused for lack of credits.
 * Null when the connection has only its own key: it then serves exactly as a
 * single-key connection always has.
 */
export function organizationAnthropicApiKeyPool(
  row: Pick<
    ConnectionRow,
    "version" | "credentialEncrypted" | "apiKeyMembers" | "apiKeyCreditRefusals"
  >,
): { id: string; credentialEncrypted: string }[] | null {
  const members = row.apiKeyMembers ?? [];
  if (members.length === 0) return null;
  const refused = row.apiKeyCreditRefusals ?? {};
  return [
    {
      id: organizationAnthropicConnectionKeyMemberId(row.version),
      credentialEncrypted: row.credentialEncrypted,
    },
    ...members.map((member) => ({
      id: member.id,
      credentialEncrypted: member.credentialEncrypted,
    })),
  ].filter((key) => refused[key.id] === undefined);
}

function normalizedLabel(label: string): string {
  const value = label.trim();
  if (!value || Buffer.byteLength(value, "utf8") > 128 || /[\r\n|]/.test(value))
    throw new Error("an API key label is 1 to 128 bytes on one line");
  return value;
}

async function lockedAnthropicConnection(
  scopedDb: Database,
  organizationId: string,
): Promise<ConnectionRow | null> {
  await scopedDb.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`organization-model-provider:${organizationId}:anthropic`}, 0))`,
  );
  const [row] = await scopedDb
    .select()
    .from(schema.organizationModelProviderConnections)
    .where(
      and(
        eq(schema.organizationModelProviderConnections.accountId, organizationId),
        eq(schema.organizationModelProviderConnections.providerKind, "anthropic"),
        eq(schema.organizationModelProviderConnections.status, "active"),
      ),
    )
    .for("update")
    .limit(1);
  return row ?? null;
}

async function writeMembers(
  scopedDb: Database,
  row: ConnectionRow,
  members: StoredAnthropicApiKeyMember[],
  refusals: Record<string, string>,
): Promise<ConnectionRow> {
  const [updated] = await scopedDb
    .update(schema.organizationModelProviderConnections)
    .set({
      apiKeyMembers: members.length ? members : null,
      apiKeyCreditRefusals: Object.keys(refusals).length ? refusals : null,
    })
    .where(eq(schema.organizationModelProviderConnections.id, row.id))
    .returning();
  if (!updated) throw new Error("organization Anthropic API key write returned no row");
  return updated;
}

/** Only the refusals of current members, so stale ones never pile up. */
function currentRefusals(
  row: ConnectionRow,
  members: StoredAnthropicApiKeyMember[],
): Record<string, string> {
  const ids = new Set([
    organizationAnthropicConnectionKeyMemberId(row.version),
    ...members.map((member) => member.id),
  ]);
  return Object.fromEntries(
    Object.entries(row.apiKeyCreditRefusals ?? {}).filter(([id]) => ids.has(id)),
  );
}

/** The organization's Anthropic API keys (never their values); null without an active connection. */
export async function listOrganizationAnthropicApiKeys(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
): Promise<OrganizationAnthropicApiKeys | null> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.organizationModelProviderConnections)
      .where(
        and(
          eq(schema.organizationModelProviderConnections.accountId, input.organizationId),
          eq(schema.organizationModelProviderConnections.providerKind, "anthropic"),
          eq(schema.organizationModelProviderConnections.status, "active"),
        ),
      )
      .limit(1);
    return row ? mapKeys(row) : null;
  });
}

/**
 * Add a further API key to the organization's active Anthropic API
 * connection. Adding a key that is already a member (same digest) returns
 * that member unchanged, so a retried request adds it once. Null without an
 * active connection: the first key is the connection itself.
 */
export async function addOrganizationAnthropicApiKey(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    label: string;
    credentialEncrypted: string;
    credentialDigest: string;
    anthropicOrganizationId: string | null;
  },
): Promise<{ key: OrganizationAnthropicApiKey; added: boolean } | null> {
  const label = normalizedLabel(input.label);
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    const row = await lockedAnthropicConnection(scopedDb, input.organizationId);
    if (!row) return null;
    const members = row.apiKeyMembers ?? [];
    const existing = members.find((member) => member.credentialDigest === input.credentialDigest);
    if (existing) {
      const key = mapKeys(row).keys.find((candidate) => candidate.id === existing.id)!;
      return { key, added: false };
    }
    if (members.length + 1 >= ORGANIZATION_ANTHROPIC_API_KEY_LIMIT)
      throw new OrganizationModelProviderLimitError(
        `an Anthropic API connection holds at most ${ORGANIZATION_ANTHROPIC_API_KEY_LIMIT} keys`,
      );
    const member: StoredAnthropicApiKeyMember = {
      id: randomUUID(),
      label,
      credentialEncrypted: input.credentialEncrypted,
      credentialDigest: input.credentialDigest,
      anthropicOrganizationId: input.anthropicOrganizationId,
      createdAt: new Date().toISOString(),
      createdBySubjectId: input.actorSubjectId,
    };
    const next = [...members, member];
    const updated = await writeMembers(scopedDb, row, next, currentRefusals(row, next));
    const key = mapKeys(updated).keys.find((candidate) => candidate.id === member.id)!;
    return { key, added: true };
  });
}

/** Rename a further key; the connection's own key has no label. Null when there is no such key. */
export async function relabelOrganizationAnthropicApiKey(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; keyId: string; label: string },
): Promise<OrganizationAnthropicApiKey | null> {
  const label = normalizedLabel(input.label);
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    const row = await lockedAnthropicConnection(scopedDb, input.organizationId);
    const members = row?.apiKeyMembers ?? [];
    if (!row || !members.some((member) => member.id === input.keyId)) return null;
    const next = members.map((member) =>
      member.id === input.keyId ? { ...member, label } : member,
    );
    const updated = await writeMembers(scopedDb, row, next, currentRefusals(row, next));
    return mapKeys(updated).keys.find((candidate) => candidate.id === input.keyId) ?? null;
  });
}

/**
 * Remove a further key. The connection's own key is replaced or disconnected
 * through the connection instead. False when there is no such key.
 */
export async function removeOrganizationAnthropicApiKey(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; keyId: string },
): Promise<boolean> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    const row = await lockedAnthropicConnection(scopedDb, input.organizationId);
    if (row && input.keyId === organizationAnthropicConnectionKeyMemberId(row.version))
      throw new OrganizationModelProviderConflictError(
        "the connection's own key is replaced or disconnected through the connection",
      );
    const members = row?.apiKeyMembers ?? [];
    if (!row || !members.some((member) => member.id === input.keyId)) return false;
    const next = members.filter((member) => member.id !== input.keyId);
    await writeMembers(scopedDb, row, next, currentRefusals(row, next));
    return true;
  });
}

/**
 * Let a key Anthropic refused for lack of credits serve again (after the
 * administrator added credits); if it is still out of credits, the next
 * request refused marks it again. Null when there is no such key.
 */
export async function clearOrganizationAnthropicApiKeyCreditRefusal(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; keyId: string },
): Promise<OrganizationAnthropicApiKey | null> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    const row = await lockedAnthropicConnection(scopedDb, input.organizationId);
    if (!row) return null;
    const before = mapKeys(row).keys.find((candidate) => candidate.id === input.keyId);
    if (!before) return null;
    const members = row.apiKeyMembers ?? [];
    const refusals = currentRefusals(row, members);
    delete refusals[input.keyId];
    const updated = await writeMembers(scopedDb, row, members, refusals);
    return mapKeys(updated).keys.find((candidate) => candidate.id === input.keyId) ?? null;
  });
}

/**
 * Record that Anthropic refused one of the organization's pooled API keys
 * for lack of credits, from a turn of one of its workspaces, so later turns
 * skip it. Only a current member is recorded; a key replaced or removed since
 * is ignored. Never touches the connection's version or keys.
 */
export async function markOrganizationAnthropicApiKeyCreditRefused(
  db: Database,
  input: { accountId: string; workspaceId: string; keyId: string; at?: Date },
): Promise<boolean> {
  const at = (input.at ?? new Date()).toISOString();
  return await withRlsContext(db, input, async (scopedDb) => {
    const rows = await scopedDb
      .update(schema.organizationModelProviderConnections)
      .set({
        apiKeyCreditRefusals: sql`coalesce(${schema.organizationModelProviderConnections.apiKeyCreditRefusals}, '{}'::jsonb) || jsonb_build_object(${input.keyId}::text, ${at}::text)`,
      })
      .where(
        and(
          eq(schema.organizationModelProviderConnections.accountId, input.accountId),
          eq(schema.organizationModelProviderConnections.providerKind, "anthropic"),
          eq(schema.organizationModelProviderConnections.status, "active"),
          sql`not coalesce(${schema.organizationModelProviderConnections.apiKeyCreditRefusals}, '{}'::jsonb) ? ${input.keyId}::text`,
          sql`(${input.keyId}::text = 'primary-v' || ${schema.organizationModelProviderConnections.version}::text
            or coalesce(${schema.organizationModelProviderConnections.apiKeyMembers}, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', ${input.keyId}::text)))`,
        ),
      )
      .returning({ id: schema.organizationModelProviderConnections.id });
    return rows.length > 0;
  });
}

/**
 * The pooled keys (encrypted) a workspace's turn may send, read under the
 * workspace's RLS scope; null for a single-key or missing connection.
 */
export async function loadOrganizationAnthropicApiKeyPoolForWorkspace(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<{ id: string; credentialEncrypted: string }[] | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        version: schema.organizationModelProviderConnections.version,
        credentialEncrypted: schema.organizationModelProviderConnections.credentialEncrypted,
        apiKeyMembers: schema.organizationModelProviderConnections.apiKeyMembers,
        apiKeyCreditRefusals: schema.organizationModelProviderConnections.apiKeyCreditRefusals,
      })
      .from(schema.organizationModelProviderConnections)
      .where(
        and(
          eq(schema.organizationModelProviderConnections.accountId, input.accountId),
          eq(schema.organizationModelProviderConnections.providerKind, "anthropic"),
          eq(schema.organizationModelProviderConnections.status, "active"),
        ),
      )
      .limit(1);
    return row ? organizationAnthropicApiKeyPool(row) : null;
  });
}

/**
 * The organization's pooled Anthropic API keys a workspace's turn may send,
 * decrypted; null for a single-key or missing connection, or without an
 * encryption key (then nothing loads, as for the connection's own key).
 */
export async function loadOrganizationAnthropicApiKeysForExecution(
  db: Database,
  settings: Settings,
  input: { accountId: string; workspaceId: string },
  prepared?: {
    loadOrganizationCredentials: boolean;
    organizationAnthropicApiKeys: { id: string; credentialEncrypted: string }[] | null;
  },
): Promise<{ id: string; apiKey: string }[] | null> {
  const key = environmentsEncryptionKeyBytes(settings);
  if (prepared && prepared.loadOrganizationCredentials !== (key !== null))
    throw new Error("Prepared provider credentials do not match encryption settings");
  if (!key) return null;
  const pool = prepared
    ? prepared.organizationAnthropicApiKeys
    : await loadOrganizationAnthropicApiKeyPoolForWorkspace(db, input);
  return (
    pool?.map((member) => ({
      id: member.id,
      apiKey: decryptEnvironmentValue(key, member.credentialEncrypted),
    })) ?? null
  );
}
