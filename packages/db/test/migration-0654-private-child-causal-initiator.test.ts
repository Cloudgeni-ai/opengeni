import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0654-private-child-initiator");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("migration 0654 requires PostgreSQL");
  }
}, 180_000);

afterAll(async () => shared?.release(), 180_000);

describe("private child causal initiator migration", () => {
  test("changes only the insert guard, leaving causal-human capability checks intact", async () => {
    const source = await readFile(
      new URL("../drizzle/0654_private_child_causal_initiator.sql", import.meta.url),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("turn_row.id = child_capability.actor_turn_id");
    expect(source).toContain("child_capability.actor_turn_id IS DISTINCT FROM NEW.parent_turn_id");
    expect(source).toContain("actor_initiator_kind IS DISTINCT FROM NEW.created_by_kind");
    expect(source).toContain(
      "actor_initiator_subject_id IS DISTINCT FROM NEW.created_by_subject_id",
    );
    expect(source).toContain(
      "child_capability.actor_subject_id IS DISTINCT FROM NEW.owner_subject_id",
    );
    expect(source).not.toContain("CREATE OR REPLACE FUNCTION open_private_child");
  });

  test("retains the data-schema search-path pin and private trigger privilege", async () => {
    if (!shared) return;
    const [routine] = await shared.admin<
      Array<{ definer: boolean; config: string[]; executable: boolean }>
    >`
      select procedure.prosecdef as definer, procedure.proconfig as config,
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as executable
      from pg_proc procedure
      where procedure.oid = to_regprocedure(current_schema() || '.guard_private_child_session_create()')`;
    expect(routine).toEqual({
      definer: true,
      config: ["search_path=pg_catalog, public, pg_temp"],
      executable: false,
    });
  });
});
