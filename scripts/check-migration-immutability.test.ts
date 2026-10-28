import { describe, expect, test } from "bun:test";
import { changedShippedMigrations } from "./check-migration-immutability";

describe("migration immutability guard", () => {
  test("allows added migrations and reports every other change to a shipped one", () => {
    const output = [
      "A\tpackages/db/drizzle/0999_new.sql",
      "M\tpackages/db/drizzle/0978_messages_wait_for_machine_owner.sql",
      "D\tpackages/db/drizzle/0979_model_call_facts_prompt_cache_diagnostics.sql",
      "T\tpackages/db/drizzle/0980_workspace_governance_context_forks.sql",
      "M\tpackages/db/drizzle/README.md",
      "M\tpackages/db/src/migrate.ts",
      "",
    ].join("\n");
    expect(changedShippedMigrations(output)).toEqual([
      { status: "M", path: "packages/db/drizzle/0978_messages_wait_for_machine_owner.sql" },
      {
        status: "D",
        path: "packages/db/drizzle/0979_model_call_facts_prompt_cache_diagnostics.sql",
      },
      { status: "T", path: "packages/db/drizzle/0980_workspace_governance_context_forks.sql" },
    ]);
  });

  test("an empty diff has no findings", () => {
    expect(changedShippedMigrations("")).toEqual([]);
  });

  test("allows deleting only retired names, and never editing them", () => {
    const output = [
      "D\tpackages/db/drizzle/0001_retired.sql",
      "M\tpackages/db/drizzle/0002_retired.sql",
      "D\tpackages/db/drizzle/0003_kept.sql",
    ].join("\n");
    expect(
      changedShippedMigrations(output, new Set(["0001_retired.sql", "0002_retired.sql"])),
    ).toEqual([
      { status: "M", path: "packages/db/drizzle/0002_retired.sql" },
      { status: "D", path: "packages/db/drizzle/0003_kept.sql" },
    ]);
  });
});
