import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "../drizzle/0381_fail_closed_rig_version_activation.sql",
  import.meta.url,
);
const source = await Bun.file(migrationUrl).text();

describe("migration 0381 fail-closed Rig activation", () => {
  test("adds operational verification state without backfilling false success", () => {
    expect(source).toMatch(
      /ADD COLUMN verification jsonb NOT NULL DEFAULT '\{"status":"unverified"\}'::jsonb/iu,
    );
    expect(source).not.toMatch(/UPDATE\s+rig_versions[\s\S]*status["']?\s*:\s*["']passed/iu);
  });

  test("scoped creation accepts an explicit inactive pending initial version", () => {
    expect(source).toContain("p_initial_version -> 'verification'");
    expect(source).toContain("(p_initial_version ->> 'active')::boolean");
    expect(source).toContain("coalesce((p_initial_version ->> 'active')::boolean, true)");
  });

  test("retains the scoped creation security boundary", () => {
    expect(source).toContain("SECURITY DEFINER SET search_path FROM CURRENT");
    expect(source).toContain("invalid scoped rig creation request");
    expect(source).toContain("organization rig creation requires account authority");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION create_scoped_rig(\n  uuid, uuid, text, text, text, text, jsonb, boolean\n) FROM PUBLIC;",
    );
  });
});
