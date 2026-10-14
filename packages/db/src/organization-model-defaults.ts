import {
  EMPTY_ORGANIZATION_MODEL_DEFAULTS,
  ModelCompactionTokenThreshold,
  type OrganizationModelDefaults,
  WorkspaceModelCompactionThresholdsPatch,
  WorkspaceSessionDefaults,
} from "@opengeni/contracts";
import { eq, sql } from "drizzle-orm";

import { type Database, setSubjectRlsContext, withRlsContext } from "./database";
import * as schema from "./schema";

type Row = typeof schema.organizationModelDefaults.$inferSelect;

/** Lenient read: a malformed or newer field resets only itself, never the row. */
function mapRow(row: Row | undefined): OrganizationModelDefaults {
  if (!row) return EMPTY_ORGANIZATION_MODEL_DEFAULTS;
  const sessionDefaults = WorkspaceSessionDefaults.safeParse(row.sessionDefaults);
  const thresholds: Record<string, number> = {};
  const stored = row.modelCompactionThresholds;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [modelId, value] of Object.entries(stored)) {
      const parsed = ModelCompactionTokenThreshold.safeParse(value);
      if (parsed.success) thresholds[modelId] = parsed.data;
    }
  }
  return {
    sessionDefaults: sessionDefaults.success ? sessionDefaults.data : null,
    allowedProviders: row.allowedProviders ?? null,
    allowedModels: row.allowedModels ?? null,
    modelCompactionThresholds: thresholds,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function readRow(scopedDb: Database, accountId: string, lock = false) {
  const query = scopedDb
    .select()
    .from(schema.organizationModelDefaults)
    .where(eq(schema.organizationModelDefaults.accountId, accountId))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row;
}

/**
 * The organization's model defaults as every workspace in it follows them.
 * Any caller scoped to the organization may read them (workers resolving a
 * turn, workspace settings pages); absent reads as no defaults.
 */
export async function getOrganizationModelDefaults(
  db: Database,
  accountId: string,
): Promise<OrganizationModelDefaults> {
  return await withRlsContext(db, { accountId, workspaceId: null }, async (scopedDb) =>
    mapRow(await readRow(scopedDb, accountId)),
  );
}

/** Reads in an organization owner's or admin's scope; anyone else is refused. */
async function withOrganizationAdministrator<T>(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
  use: (scopedDb: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      // Raises 42501 unless the actor is an active owner or admin.
      await scopedDb.execute(sql`
        select get_organization_administration_overview(
          ${input.organizationId}::uuid, ${input.actorSubjectId}
        )
      `);
      return await use(scopedDb);
    },
  );
}

export async function getOrganizationModelDefaultsForAdministrator(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
): Promise<OrganizationModelDefaults> {
  return await withOrganizationAdministrator(db, input, async (scopedDb) =>
    mapRow(await readRow(scopedDb, input.organizationId)),
  );
}

export type OrganizationModelDefaultsPatch = {
  /** Undefined keeps it; null makes the default model automatic again. */
  sessionDefaults?: OrganizationModelDefaults["sessionDefaults"] | undefined;
  /** Undefined keeps both allowlists; otherwise replaces them (null = everything). */
  modelPolicy?:
    | {
        allowedProviders: string[] | null;
        allowedModels: string[] | null;
      }
    | null
    | undefined;
  /** Merged by exact model id; null resets just that model. */
  modelCompactionThresholds?: unknown;
};

/**
 * Update organization model defaults, field by field. Concurrent edits to
 * different fields or different models both survive: the row is locked and
 * each field is merged into what is stored now, not into what a page read.
 */
export async function updateOrganizationModelDefaults(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    patch: OrganizationModelDefaultsPatch;
  },
): Promise<OrganizationModelDefaults> {
  const thresholdPatch =
    input.patch.modelCompactionThresholds === undefined
      ? undefined
      : WorkspaceModelCompactionThresholdsPatch.parse(input.patch.modelCompactionThresholds);
  return await withOrganizationAdministrator(db, input, async (scopedDb) => {
    await scopedDb
      .insert(schema.organizationModelDefaults)
      .values({ accountId: input.organizationId, updatedBySubjectId: input.actorSubjectId })
      .onConflictDoNothing({ target: schema.organizationModelDefaults.accountId });
    const current = mapRow(await readRow(scopedDb, input.organizationId, true));
    const thresholds = { ...current.modelCompactionThresholds };
    for (const [modelId, value] of Object.entries(thresholdPatch ?? {})) {
      if (value === null) delete thresholds[modelId];
      else thresholds[modelId] = value;
    }
    if (Object.keys(thresholds).length > 512) {
      throw new RangeError("At most 512 model compaction preferences per organization");
    }
    const policy =
      input.patch.modelPolicy === undefined
        ? { allowedProviders: current.allowedProviders, allowedModels: current.allowedModels }
        : {
            allowedProviders: input.patch.modelPolicy?.allowedProviders ?? null,
            allowedModels: input.patch.modelPolicy?.allowedModels ?? null,
          };
    const [row] = await scopedDb
      .update(schema.organizationModelDefaults)
      .set({
        sessionDefaults:
          input.patch.sessionDefaults === undefined
            ? current.sessionDefaults
            : input.patch.sessionDefaults,
        allowedProviders: policy.allowedProviders,
        allowedModels: policy.allowedModels,
        modelCompactionThresholds: thresholds,
        updatedBySubjectId: input.actorSubjectId,
        updatedAt: new Date(),
      })
      .where(eq(schema.organizationModelDefaults.accountId, input.organizationId))
      .returning();
    return mapRow(row);
  });
}
