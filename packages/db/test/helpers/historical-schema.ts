import { readdir } from "node:fs/promises";
import { acquireBlankTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate, type MigrationRuntimeOptions } from "../../src/migrate";
import { provisionRoles } from "../../src/provision-roles";

/** Test-only historical replay: never teach the production migrator to stop early. */
export async function migrateBefore(
  url: string,
  upperBound: string,
  options?: MigrationRuntimeOptions,
): Promise<void> {
  const files = (await readdir(new URL("../../drizzle/", import.meta.url))).filter(
    (file) => file.endsWith(".sql") && file >= upperBound,
  );
  const ledger = postgres(url, { max: 1, onnotice: () => undefined });
  const inserted: string[] = [];
  try {
    await ledger.unsafe(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const file of files) {
      if (
        (
          await ledger`INSERT INTO schema_migrations (name) VALUES (${file}) ON CONFLICT DO NOTHING RETURNING name`
        ).length
      )
        inserted.push(file);
    }
    // The owner can also be a configured runtime identity in historical tests.
    // Do not keep a second idle connection alive across the maintenance drain.
    await ledger.end();
    await migrate(url, undefined, options);
    // These historical fixtures exercise old lifecycle behavior with today's
    // TypeScript readers. Supply only the nullable reader column, not the 0488
    // deletion lifecycle or guards (which would change the behavior under test).
    if (
      upperBound > "0433_unified_skill_lifecycle.sql" &&
      upperBound <= "0488_permanent_skill_removal.sql"
    ) {
      const readerColumns = postgres(url, { max: 1, onnotice: () => undefined });
      try {
        await readerColumns`ALTER TABLE preference_registry_revisions
          ADD COLUMN IF NOT EXISTS skill_removal_operation_id uuid`;
      } finally {
        await readerColumns.end();
      }
    }
  } finally {
    await ledger.end();
    const cleanup = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      for (const file of inserted) await cleanup`DELETE FROM schema_migrations WHERE name=${file}`;
    } finally {
      await cleanup.end();
    }
  }
}

export async function acquirePreRemovalDatabase(label: string): Promise<SharedTestDatabase | null> {
  const blank = await acquireBlankTestDatabase(label);
  if (!blank) return null;
  try {
    await migrateBefore(blank.databaseUrl, "0482_remove_packs.sql");
    await provisionRoles(blank.databaseUrl, {
      ...(blank.appPassword ? { appPassword: blank.appPassword } : {}),
      temporalDatabases: [],
    });
    const appUrl = new URL(blank.databaseUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = blank.appPassword ?? "apppw";
    const admin = postgres(blank.databaseUrl, { max: 4 });
    return {
      admin,
      adminUrl: blank.databaseUrl,
      appUrl: appUrl.toString(),
      release: async () => {
        await admin.end();
        await blank.release();
      },
    };
  } catch (error) {
    await blank.release();
    throw error;
  }
}
