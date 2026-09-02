import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "../drizzle/0393_fail_closed_rig_version_activation.sql",
  import.meta.url,
);
const source = await Bun.file(migrationUrl).text();

describe("migration 0393 fail-closed Rig activation", () => {
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
    expect(source).toContain("receipt' ->> 'version' IS DISTINCT FROM '3'");
    expect(source).toContain("provenance' ->> 'authority'");
    expect(source).toContain("deployment_control_plane");
    expect(source).toContain("provenance' ->> 'providerImage'");
    expect(source).toContain("provenance' ->> 'providerImageId'");
    expect(source).toContain("jsonb_each(NEW.provider_images)");
    expect(source).toContain("image.value ->> 'buildRequestId'");
  });

  test("removes complete obsolete artifact references while preserving current proof", () => {
    expect(source).toContain("jsonb_object_agg(image.key, image.value) FILTER");
    expect(source).toContain("NOT IN ('1', '2')");
    expect(source).toContain("SET verification = verification - 'providerImage'");
    expect(source).toContain(
      "verification #>> '{providerImage,coldBootValidation,version}' IN ('1', '2')",
    );
    expect(source).toContain("rig_versions_provider_image_proof_trigger");
    expect(source).toContain("rig_versions_provider_image_proof_version_check");
    expect(source).toContain("coldBootValidation' ->> 'version' IS DISTINCT FROM '3'");
    expect(source).not.toMatch(/jsonb_set\([\s\S]*\{coldBootValidation\}[\s\S]*'null'::jsonb/iu);
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
