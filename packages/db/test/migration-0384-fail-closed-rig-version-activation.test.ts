import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "../drizzle/0384_fail_closed_rig_version_activation.sql",
  import.meta.url,
);
const source = await Bun.file(migrationUrl).text();

describe("migration 0384 fail-closed Rig activation", () => {
  test("adds operational verification state without backfilling false success", () => {
    expect(source).toMatch(
      /ADD COLUMN verification jsonb NOT NULL DEFAULT '\{"status":"unverified"\}'::jsonb/iu,
    );
    expect(source).not.toMatch(/UPDATE\s+rig_versions[\s\S]*status["']?\s*:\s*["']passed/iu);
  });

  test("scoped creation accepts an explicit inactive pending initial version", () => {
    expect(source).toContain("p_initial_version -> 'verification'");
    expect(source).toContain("(p_initial_version ->> 'active')::boolean");
    expect(source).toContain("coalesce((p_initial_version ->> 'active')::boolean, false)");
  });

  test("fences active inserts and inactive-to-active transitions at the database boundary", () => {
    expect(source).toContain("rig_versions_active_verification_trigger");
    expect(source).toContain("TG_OP = 'INSERT' OR OLD.active IS DISTINCT FROM true");
    expect(source).toContain("rig_versions_active_verification_check");
    expect(source).toContain("binding' ->> 'sandboxGroupId'");
    expect(source).toContain("binding' ->> 'rigVersionId'");
    expect(source).toContain("receipt' ->> 'version' IS DISTINCT FROM '2'");
  });

  test("removes and fences obsolete provider-image proof across the maintenance cutover", () => {
    expect(source).toContain("THEN image.value - 'coldBootValidation'");
    expect(source).toContain("rig_versions_provider_image_proof_trigger");
    expect(source).toContain("rig_versions_provider_image_proof_version_check");
    expect(source).toContain("coldBootValidation' ->> 'version' = '1'");
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
