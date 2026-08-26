import { describe, expect, test } from "bun:test";

import {
  FORCE_RLS_TABLES,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
} from "../src/runtime-posture";

const migrationUrl = new URL(
  "../drizzle/0361_remember_knowledge_memory_materialization.sql",
  import.meta.url,
);
const migration = await Bun.file(migrationUrl).text();

describe("migration 0361 remember Knowledge Memory materialization", () => {
  test("owns exact, idempotent confirmation-to-Memory materialization", () => {
    expect(migration).toContain("CREATE TABLE remember_knowledge_memory_materializations");
    expect(migration).toContain("confirmation_receipt_id uuid PRIMARY KEY");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("fact.object_value #>> '{}'");
    expect(migration).toContain("receipt_row.task_note_text_hash");
    expect(migration).toContain("'remember/' || receipt_row.id::text");
    expect(migration).toContain("'confirmationReceiptId', receipt_row.id");
    expect(migration).toContain("RETURN NEXT result_row");
    expect(migration).not.toContain("ON CONFLICT");
  });

  test("is a target-schema capability with no direct runtime table DML", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION materialize_remember_knowledge_memory");
    expect(migration).toContain("LANGUAGE plpgsql SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(migration).toContain(
      "REVOKE ALL ON TABLE remember_knowledge_memory_materializations FROM PUBLIC",
    );
    expect(FORCE_RLS_TABLES).toContain("remember_knowledge_memory_materializations");
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain("remember_knowledge_memory_materializations");
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(
      "materialize_remember_knowledge_memory(uuid, uuid, uuid)",
    );
  });
});
