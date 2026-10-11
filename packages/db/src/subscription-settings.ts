/**
 * Organization subscription settings with lockable workspace overrides and
 * the organization overview (design docs/design/subscription-core-2026-10-07.md
 * 3.3, contract SUB-SET-01..05).
 *
 * Values are read through `subscription_effective_settings`, the SQL
 * resolver the core enforces with; nothing here resolves a setting itself.
 * Authority is the database's: organization rows are written only by
 * organization administrators (the settings manager policy), workspace rows
 * by workspace or organization administrators, and a locked setting cannot be
 * widened by anyone (the 0716 guard). The checks below only turn those
 * refusals into typed errors before anything is written.
 */
import {
  SUBSCRIPTION_SETTING_KEYS,
  fallbackOrderProblem,
  isSubscriptionSettingKey,
  lockedSettingsWidened,
  settingsViewFromEffective,
  type SubscriptionSettingKey,
  type SubscriptionSettingOverrides,
  type SubscriptionSettingsView,
  type SubscriptionSettingValues,
} from "@opengeni/subscriptions";
import { sql } from "drizzle-orm";

import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";
import { readSubscriptionEffectiveSettings } from "./subscription-core-repository";
import { readSubscriptionCorePrimaryConnectionId } from "./subscription-core/administration";
import { subscriptionCoreProvider } from "./subscription-core-providers";
import type { SubscriptionCoreProvider } from "./subscription-core/provider";

export type SubscriptionRotationMode = "spread" | "primary_first";

/** The caller may not read or write these settings. */
export class SubscriptionSettingsForbiddenError extends Error {
  constructor(message = "missing permission to manage these model account settings") {
    super(message);
    this.name = "SubscriptionSettingsForbiddenError";
  }
}

/** The write would override settings the organization locked. */
export class SubscriptionSettingsLockedError extends Error {
  constructor(readonly settings: readonly SubscriptionSettingKey[]) {
    super(`locked by the organization: ${settings.join(", ")}`);
    this.name = "SubscriptionSettingsLockedError";
  }
}

/** The caller's expected version is not the stored one. */
export class SubscriptionSettingsVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("these settings changed since they were read");
    this.name = "SubscriptionSettingsVersionConflictError";
  }
}

/** A Personal workspace follows the organization; it holds no overrides. */
export class SubscriptionSettingsPersonalWorkspaceError extends Error {
  constructor() {
    super("a Personal workspace follows the organization's model account settings");
    this.name = "SubscriptionSettingsPersonalWorkspaceError";
  }
}

/** The patch is not a valid settings change. */
export class SubscriptionSettingsInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionSettingsInvalidError";
  }
}

export type OrganizationSubscriptionSettingsState = {
  organizationId: string;
  /** Every value set: the organization row, with the resolver's defaults for absent values. */
  values: SubscriptionSettingValues;
  locked: SubscriptionSettingKey[];
  /** 0 while the organization has no settings row. */
  version: number;
  updatedAt: string | null;
};

export type OrganizationSubscriptionSettingsPatch = {
  crossProviderFailover?: boolean | undefined;
  /** Replaces the organization's fallback order. */
  fallbackOrder?: Record<string, string[]> | undefined;
  personalConnectionsAllowed?: boolean | undefined;
  personalFallbackAllowed?: boolean | undefined;
  /** Per provider on the shared core; the provider's primary connection is unchanged. */
  rotation?: Record<string, { mode: SubscriptionRotationMode }> | undefined;
  /** Replaces the set of locked settings. */
  locked?: SubscriptionSettingKey[] | undefined;
};

/** A workspace row as stored: null inherits the organization value. */
export type WorkspaceSubscriptionSettingOverrides = {
  rotation: Record<string, unknown> | null;
  providers: Record<string, unknown> | null;
  crossProviderFailover: boolean | null;
  fallbackOrder: Record<string, string[]> | null;
  personalConnectionsAllowed: boolean | null;
  personalFallbackAllowed: boolean | null;
};

export type WorkspaceSubscriptionSettingsState = SubscriptionSettingsView & {
  workspaceId: string;
  locked: SubscriptionSettingKey[];
  overrides: WorkspaceSubscriptionSettingOverrides;
  /** 0 while the workspace has no settings row. */
  version: number;
  updatedAt: string | null;
  /** Whether the caller administers this workspace's settings (the database decides writes). */
  canEdit: boolean;
};

/**
 * A workspace change: `null` resets a setting to the organization value. A
 * map-valued setting changes entry by entry (D-25); a `null` entry resets
 * that entry.
 */
export type WorkspaceSubscriptionSettingsPatch = {
  crossProviderFailover?: boolean | null | undefined;
  personalConnectionsAllowed?: boolean | null | undefined;
  personalFallbackAllowed?: boolean | null | undefined;
  fallbackOrder?: Record<string, string[] | null> | null | undefined;
  rotation?: Record<string, { mode: SubscriptionRotationMode } | null> | null | undefined;
};

export type SubscriptionSettingsOverviewWorkspace = SubscriptionSettingsView & {
  workspaceId: string;
  name: string;
};

export type SubscriptionSettingsOverviewState = {
  organization: OrganizationSubscriptionSettingsState;
  workspaces: SubscriptionSettingsOverviewWorkspace[];
  /** The cursor for the next page, or null after the last workspace. */
  nextCursor: string | null;
};

/** Who a settings write should wake (capacity waiters recheck their placement). */
export type SubscriptionSettingsWake = {
  accountId: string;
  reason: typeof SUBSCRIPTION_SETTINGS_WAKE_REASON;
  workspaceIds?: string[];
};

export const SUBSCRIPTION_SETTINGS_WAKE_REASON = "core_settings_changed";

const PROVIDER_ID = /^[a-z][a-z0-9_]{1,31}$/;
/** No workspace has this id, so the resolver returns the organization values. */
const NO_WORKSPACE = "00000000-0000-0000-0000-000000000000";
const OVERVIEW_PAGE_LIMIT = 500;

function normalizeLocked(locked: readonly unknown[]): SubscriptionSettingKey[] {
  const unknown = locked.filter((key) => !isSubscriptionSettingKey(key));
  if (unknown.length > 0) throw new SubscriptionSettingsInvalidError("unknown setting");
  return SUBSCRIPTION_SETTING_KEYS.filter((key) => locked.includes(key));
}

function storedLocked(value: unknown): SubscriptionSettingKey[] {
  return Array.isArray(value) ? SUBSCRIPTION_SETTING_KEYS.filter((key) => value.includes(key)) : [];
}

function iso(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function lockRefusal(error: unknown): SubscriptionSettingKey[] | null {
  const queue: unknown[] = [error];
  for (let index = 0; index < queue.length && index < 16; index += 1) {
    const current = queue[index] as { detail?: unknown; cause?: unknown } | null;
    if (!current || typeof current !== "object") continue;
    if (typeof current.detail === "string" && current.detail.startsWith("subscription_setting_locked:")) {
      const key = current.detail.slice("subscription_setting_locked:".length);
      return isSubscriptionSettingKey(key) ? [key] : [];
    }
    if (current.cause !== undefined) queue.push(current.cause);
  }
  return null;
}

function translateWriteError(error: unknown): never {
  const locked = lockRefusal(error);
  if (locked) throw new SubscriptionSettingsLockedError(locked);
  if (nestedPostgresSqlState(error) === "42501") throw new SubscriptionSettingsForbiddenError();
  throw error;
}

function registeredProvider(providerId: string): SubscriptionCoreProvider {
  if (!PROVIDER_ID.test(providerId)) {
    throw new SubscriptionSettingsInvalidError("unknown provider");
  }
  try {
    return subscriptionCoreProvider(providerId);
  } catch {
    // Fail closed: a provider whose accounts are not on the shared core yet
    // keeps its own rotation, so a core value would have no effect.
    throw new SubscriptionSettingsInvalidError(
      `rotation for ${providerId} is not managed by these settings yet`,
    );
  }
}

function validateRotationMode(value: unknown): SubscriptionRotationMode {
  const mode = (value as { mode?: unknown } | null)?.mode;
  if (mode !== "spread" && mode !== "primary_first") {
    throw new SubscriptionSettingsInvalidError("rotation mode must be spread or primary_first");
  }
  return mode;
}

function validateFallbackOrder(order: unknown): Record<string, string[]> {
  const problem = fallbackOrderProblem(order);
  if (problem) throw new SubscriptionSettingsInvalidError(problem);
  return order as Record<string, string[]>;
}

async function isOrganizationAdministrator(tx: Database, accountId: string): Promise<boolean> {
  const [row] = await rawRows<{ allowed: boolean | null }>(
    tx,
    sql`select opengeni_private.subscription_organization_admin(${accountId}::uuid) as allowed`,
  );
  return row?.allowed === true;
}

async function withOrganizationAdministrator<T>(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
  use: (tx: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (tx) => {
      await setSubjectRlsContext(tx, input.actorSubjectId);
      if (!(await isOrganizationAdministrator(tx, input.organizationId))) {
        throw new SubscriptionSettingsForbiddenError(
          "Only organization owners and admins can manage organization model account settings",
        );
      }
      return await use(tx);
    },
  );
}

async function readOrganizationState(
  tx: Database,
  organizationId: string,
): Promise<OrganizationSubscriptionSettingsState> {
  const [row] = await rawRows<{
    locked_settings: string[] | null;
    version: number | string | null;
    updated_at: Date | string | null;
  }>(
    tx,
    sql`select locked_settings, version, updated_at from subscription_settings
      where account_id = ${organizationId}::uuid and workspace_id is null`,
  );
  const effective = await readSubscriptionEffectiveSettings(tx, organizationId, NO_WORKSPACE);
  return {
    organizationId,
    values: effective.values,
    locked: storedLocked(row?.locked_settings),
    version: row ? Number(row.version) : 0,
    updatedAt: iso(row?.updated_at),
  };
}

export async function readOrganizationSubscriptionSettings(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
): Promise<OrganizationSubscriptionSettingsState> {
  return await withOrganizationAdministrator(db, input, (tx) =>
    readOrganizationState(tx, input.organizationId),
  );
}

/**
 * Update organization settings and locks in one transaction. Locking a
 * setting clears its workspace overrides (the 0716 trigger); the
 * organization's workspace rows are locked first, before the organization
 * row, the order every workspace writer follows.
 */
export async function updateOrganizationSubscriptionSettings(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    patch: OrganizationSubscriptionSettingsPatch;
    expectedVersion?: number;
  },
): Promise<{ settings: OrganizationSubscriptionSettingsState; wake: SubscriptionSettingsWake | null }> {
  const patch = input.patch;
  const locked = patch.locked === undefined ? undefined : normalizeLocked(patch.locked);
  const fallbackOrder =
    patch.fallbackOrder === undefined ? undefined : validateFallbackOrder(patch.fallbackOrder);
  const rotation: Record<string, { mode: SubscriptionRotationMode }> = {};
  for (const [providerId, entry] of Object.entries(patch.rotation ?? {})) {
    registeredProvider(providerId);
    rotation[providerId] = { mode: validateRotationMode(entry) };
  }
  try {
    return await withOrganizationAdministrator(db, input, async (tx) => {
      await rawRows(
        tx,
        sql`insert into subscription_settings (
            account_id, workspace_id, rotation, providers, cross_provider_failover, fallback_order,
            personal_connections_allowed, personal_fallback_allowed, updated_by_subject_id
          ) values (
            ${input.organizationId}::uuid, null, '{}'::jsonb, '{}'::jsonb, false, '{}'::jsonb,
            true, false, ${input.actorSubjectId}
          ) on conflict (account_id, workspace_id) do nothing`,
      );
      if (locked !== undefined) {
        await rawRows(
          tx,
          sql`select id from subscription_settings
            where account_id = ${input.organizationId}::uuid and workspace_id is not null
            order by id for update`,
        );
      }
      const [current] = await rawRows<{ version: number | string; locked_settings: string[] }>(
        tx,
        sql`select version, locked_settings from subscription_settings
          where account_id = ${input.organizationId}::uuid and workspace_id is null
          for update`,
      );
      if (!current) throw new SubscriptionSettingsForbiddenError();
      if (input.expectedVersion !== undefined && Number(current.version) !== input.expectedVersion) {
        throw new SubscriptionSettingsVersionConflictError(Number(current.version));
      }
      const rotationJson = Object.keys(rotation).length === 0 ? null : JSON.stringify(rotation);
      const lockedJson = locked === undefined ? null : JSON.stringify(locked);
      await rawRows(
        tx,
        sql`update subscription_settings set
            cross_provider_failover = coalesce(${patch.crossProviderFailover ?? null}::boolean,
              cross_provider_failover),
            fallback_order = coalesce(${fallbackOrder === undefined ? null : JSON.stringify(fallbackOrder)}::jsonb,
              fallback_order),
            personal_connections_allowed = coalesce(${patch.personalConnectionsAllowed ?? null}::boolean,
              personal_connections_allowed),
            personal_fallback_allowed = coalesce(${patch.personalFallbackAllowed ?? null}::boolean,
              personal_fallback_allowed),
            rotation = case when ${rotationJson}::jsonb is null then rotation
              else coalesce(rotation, '{}'::jsonb) || ${rotationJson}::jsonb end,
            locked_settings = case when ${lockedJson}::jsonb is null then locked_settings
              else array(select jsonb_array_elements_text(${lockedJson}::jsonb)) end,
            version = version + 1,
            updated_by_subject_id = ${input.actorSubjectId},
            updated_at = clock_timestamp()
          where account_id = ${input.organizationId}::uuid and workspace_id is null`,
      );
      return {
        settings: await readOrganizationState(tx, input.organizationId),
        wake: { accountId: input.organizationId, reason: SUBSCRIPTION_SETTINGS_WAKE_REASON },
      };
    });
  } catch (error) {
    if (
      error instanceof SubscriptionSettingsForbiddenError ||
      error instanceof SubscriptionSettingsVersionConflictError
    ) {
      throw error;
    }
    translateWriteError(error);
  }
}

type WorkspaceRow = {
  rotation: Record<string, unknown> | null;
  providers: Record<string, unknown> | null;
  cross_provider_failover: boolean | null;
  fallback_order: Record<string, string[]> | null;
  personal_connections_allowed: boolean | null;
  personal_fallback_allowed: boolean | null;
  version: number | string;
  updated_at: Date | string | null;
};

const WORKSPACE_COLUMNS = sql`rotation, providers, cross_provider_failover, fallback_order,
  personal_connections_allowed, personal_fallback_allowed, version, updated_at`;

function overridesOf(row: WorkspaceRow | undefined): WorkspaceSubscriptionSettingOverrides {
  return {
    rotation: row?.rotation ?? null,
    providers: row?.providers ?? null,
    crossProviderFailover: row?.cross_provider_failover ?? null,
    fallbackOrder: row?.fallback_order ?? null,
    personalConnectionsAllowed: row?.personal_connections_allowed ?? null,
    personalFallbackAllowed: row?.personal_fallback_allowed ?? null,
  };
}

/** The overrides as the pure lock check reads them (an absent value is undefined). */
function asPolicyOverrides(
  overrides: WorkspaceSubscriptionSettingOverrides,
): SubscriptionSettingOverrides {
  const result: Record<string, unknown> = {};
  if (overrides.rotation !== null) result.rotation = overrides.rotation;
  if (overrides.providers !== null) result.providers = overrides.providers;
  if (overrides.crossProviderFailover !== null) {
    result.crossProviderFailover = overrides.crossProviderFailover;
  }
  if (overrides.fallbackOrder !== null) result.fallbackOrder = overrides.fallbackOrder;
  if (overrides.personalConnectionsAllowed !== null) {
    result.personalConnectionsAllowed = overrides.personalConnectionsAllowed;
  }
  if (overrides.personalFallbackAllowed !== null) {
    result.personalFallbackAllowed = overrides.personalFallbackAllowed;
  }
  return result as SubscriptionSettingOverrides;
}

async function isPersonalWorkspace(
  tx: Database,
  input: { accountId: string; workspaceId: string },
): Promise<boolean> {
  // Runs in this workspace's RLS context, which get_workspace_kind requires.
  const [row] = await rawRows<{ kind: string }>(
    tx,
    sql`select get_workspace_kind(${input.accountId}::uuid, ${input.workspaceId}::uuid) as kind`,
  );
  // Fail closed: anything but a shared workspace is treated as personal.
  return row?.kind !== "shared";
}

async function workspaceAdministrator(
  tx: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<boolean> {
  if (await isPersonalWorkspace(tx, input)) return false;
  if (await isOrganizationAdministrator(tx, input.accountId)) return true;
  const [row] = await rawRows<{ admin: boolean }>(
    tx,
    sql`select exists (
        select 1 from workspace_memberships grant_row
        where grant_row.account_id = ${input.accountId}::uuid
          and grant_row.workspace_id = ${input.workspaceId}::uuid
          and grant_row.subject_id = ${input.subjectId}
          and grant_row.role = 'admin'
      ) as admin`,
  );
  return row?.admin === true;
}

async function readWorkspaceState(
  tx: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<WorkspaceSubscriptionSettingsState> {
  const [organization] = await rawRows<{ locked_settings: string[] | null }>(
    tx,
    sql`select locked_settings from subscription_settings
      where account_id = ${input.accountId}::uuid and workspace_id is null`,
  );
  const [row] = await rawRows<WorkspaceRow>(
    tx,
    sql`select ${WORKSPACE_COLUMNS} from subscription_settings
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid`,
  );
  const locked = storedLocked(organization?.locked_settings);
  const effective = await readSubscriptionEffectiveSettings(tx, input.accountId, input.workspaceId);
  return {
    ...settingsViewFromEffective(effective, locked),
    workspaceId: input.workspaceId,
    locked,
    overrides: overridesOf(row),
    version: row ? Number(row.version) : 0,
    updatedAt: iso(row?.updated_at),
    canEdit: await workspaceAdministrator(tx, input),
  };
}

async function withWorkspaceSubject<T>(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
  use: (tx: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      return await use(tx);
    },
  );
}

/** A workspace's effective settings, sources, locks and stored overrides. */
export async function readWorkspaceSubscriptionSettings(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<WorkspaceSubscriptionSettingsState> {
  return await withWorkspaceSubject(db, input, (tx) => readWorkspaceState(tx, input));
}

function mergeEntries<T>(
  stored: Record<string, unknown> | null,
  patch: Record<string, T | null>,
): Record<string, unknown> | null {
  const merged: Record<string, unknown> = { ...stored };
  for (const [entry, value] of Object.entries(patch)) {
    if (value === null) delete merged[entry];
    else merged[entry] = value;
  }
  return Object.keys(merged).length === 0 ? null : merged;
}

/**
 * Change a workspace's overrides. Refuses (before writing) a change that
 * would widen a locked setting; the database guard refuses it again if a lock
 * lands concurrently. Resetting an override is always allowed.
 */
export async function updateWorkspaceSubscriptionSettings(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    patch: WorkspaceSubscriptionSettingsPatch;
    expectedVersion?: number;
  },
): Promise<{ settings: WorkspaceSubscriptionSettingsState; wake: SubscriptionSettingsWake | null }> {
  const patch = input.patch;
  if (patch.fallbackOrder) {
    for (const [preferred, fallbacks] of Object.entries(patch.fallbackOrder)) {
      if (fallbacks !== null) validateFallbackOrder({ [preferred]: fallbacks });
    }
  }
  const rotationProviders = new Map<string, SubscriptionCoreProvider>();
  for (const [providerId, entry] of Object.entries(patch.rotation ?? {})) {
    if (!PROVIDER_ID.test(providerId)) throw new SubscriptionSettingsInvalidError("unknown provider");
    if (entry === null) continue;
    validateRotationMode(entry);
    rotationProviders.set(providerId, registeredProvider(providerId));
  }
  try {
    return await withWorkspaceSubject(db, input, async (tx) => {
      if (await isPersonalWorkspace(tx, input)) throw new SubscriptionSettingsPersonalWorkspaceError();
      const [organization] = await rawRows<{ locked_settings: string[] | null }>(
        tx,
        sql`select locked_settings from subscription_settings
          where account_id = ${input.accountId}::uuid and workspace_id is null`,
      );
      const locked = storedLocked(organization?.locked_settings);
      let [row] = await rawRows<WorkspaceRow>(
        tx,
        sql`select ${WORKSPACE_COLUMNS} from subscription_settings
          where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
          for update`,
      );
      if (input.expectedVersion !== undefined && (row ? Number(row.version) : 0) !== input.expectedVersion) {
        throw new SubscriptionSettingsVersionConflictError(row ? Number(row.version) : 0);
      }
      const before = overridesOf(row);
      const after: WorkspaceSubscriptionSettingOverrides = { ...before };
      if (patch.crossProviderFailover !== undefined) {
        after.crossProviderFailover = patch.crossProviderFailover;
      }
      if (patch.personalConnectionsAllowed !== undefined) {
        after.personalConnectionsAllowed = patch.personalConnectionsAllowed;
      }
      if (patch.personalFallbackAllowed !== undefined) {
        after.personalFallbackAllowed = patch.personalFallbackAllowed;
      }
      if (patch.fallbackOrder !== undefined) {
        after.fallbackOrder =
          patch.fallbackOrder === null
            ? null
            : (mergeEntries(before.fallbackOrder, patch.fallbackOrder) as Record<
                string,
                string[]
              > | null);
      }
      if (patch.rotation !== undefined) {
        after.rotation =
          patch.rotation === null
            ? null
            : mergeEntries(
                before.rotation,
                Object.fromEntries(
                  Object.entries(patch.rotation).map(([providerId, entry]) => [
                    providerId,
                    entry === null ? null : { mode: validateRotationMode(entry) },
                  ]),
                ),
              );
      }
      // A new workspace rotation entry keeps the primary in effect: the
      // organization's, which the workspace inherited until now.
      const primaries: { column: string; connectionId: string | null }[] = [];
      for (const [providerId, provider] of rotationProviders) {
        const column = provider.settings.primaryColumn;
        if (column === null || (before.rotation && providerId in before.rotation)) continue;
        primaries.push({
          column,
          connectionId: await readSubscriptionCorePrimaryConnectionId(
            tx,
            provider,
            input.accountId,
            null,
          ),
        });
      }
      const widened = lockedSettingsWidened({
        locked,
        before: asPolicyOverrides(before),
        after: asPolicyOverrides(after),
        primaryConnectionIds: {
          before: {},
          after: Object.fromEntries(primaries.map((entry) => [entry.column, entry.connectionId])),
        },
      });
      if (widened.length > 0) throw new SubscriptionSettingsLockedError(widened);
      if (!row) {
        await rawRows(
          tx,
          sql`insert into subscription_settings (account_id, workspace_id, updated_by_subject_id)
            values (${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.subjectId})
            on conflict (account_id, workspace_id) do nothing`,
        );
        [row] = await rawRows<WorkspaceRow>(
          tx,
          sql`select ${WORKSPACE_COLUMNS} from subscription_settings
            where account_id = ${input.accountId}::uuid
              and workspace_id = ${input.workspaceId}::uuid
            for update`,
        );
        if (!row) throw new SubscriptionSettingsForbiddenError();
      }
      const primaryAssignments = primaries.map(
        (entry) => sql`${sql.identifier(entry.column)} = ${entry.connectionId}::uuid,`,
      );
      const updated = await rawRows<{ id: string }>(
        tx,
        sql`update subscription_settings set
            cross_provider_failover = ${after.crossProviderFailover}::boolean,
            personal_connections_allowed = ${after.personalConnectionsAllowed}::boolean,
            personal_fallback_allowed = ${after.personalFallbackAllowed}::boolean,
            fallback_order = ${after.fallbackOrder === null ? null : JSON.stringify(after.fallbackOrder)}::jsonb,
            rotation = ${after.rotation === null ? null : JSON.stringify(after.rotation)}::jsonb,
            ${sql.join(primaryAssignments, sql` `)}
            version = version + 1,
            updated_by_subject_id = ${input.subjectId},
            updated_at = clock_timestamp()
          where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
          returning id::text as id`,
      );
      if (updated.length === 0) throw new SubscriptionSettingsForbiddenError();
      return {
        settings: await readWorkspaceState(tx, input),
        wake: {
          accountId: input.accountId,
          reason: SUBSCRIPTION_SETTINGS_WAKE_REASON,
          workspaceIds: [input.workspaceId],
        },
      };
    });
  } catch (error) {
    if (
      error instanceof SubscriptionSettingsForbiddenError ||
      error instanceof SubscriptionSettingsLockedError ||
      error instanceof SubscriptionSettingsVersionConflictError ||
      error instanceof SubscriptionSettingsInvalidError ||
      error instanceof SubscriptionSettingsPersonalWorkspaceError
    ) {
      throw error;
    }
    translateWriteError(error);
  }
}

/**
 * Every shared workspace's effective settings with one source per setting
 * (SUB-SET-05), read through the same SQL resolver the core enforces with.
 * Organization administrators only. Personal workspaces are not listed, as
 * in the organization administration overview. Ordered by workspace id and
 * paged by `after` (the previous page's `nextCursor`).
 */
export async function readSubscriptionSettingsOverview(
  db: Database,
  input: { organizationId: string; actorSubjectId: string; after?: string | null; limit?: number },
): Promise<SubscriptionSettingsOverviewState> {
  const limit = Math.max(1, Math.min(input.limit ?? OVERVIEW_PAGE_LIMIT, OVERVIEW_PAGE_LIMIT));
  return await withOrganizationAdministrator(db, input, async (tx) => {
    const organization = await readOrganizationState(tx, input.organizationId);
    const rows = await rawRows<{
      id: string;
      name: string;
      effective: Parameters<typeof settingsViewFromEffective>[0];
    }>(
      tx,
      sql`select workspace.id::text as id, workspace.name,
          subscription_effective_settings(workspace.account_id, workspace.id) as effective
        from workspaces workspace
        where workspace.account_id = ${input.organizationId}::uuid
          and workspace.id in (
            select workspace_id from list_organization_workspace_ids(${input.organizationId}::uuid)
          )
          and (${input.after ?? null}::uuid is null or workspace.id > ${input.after ?? null}::uuid)
        order by workspace.id
        limit ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    return {
      organization,
      workspaces: page.map((row) => ({
        ...settingsViewFromEffective(row.effective, organization.locked),
        workspaceId: row.id,
        name: row.name,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  });
}
