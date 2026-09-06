import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("migration 0401 organization setup token transport", () => {
  test("is rolling, fences v1 query retries, and freezes transport after durable prepare", () => {
    const source = readFileSync(
      new URL("../drizzle/0401_organization_user_setup_token_transport.sql", import.meta.url),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("ADD COLUMN setup_token_transport text");
    expect(source).toContain(
      "CHECK (setup_token_transport IS NULL OR setup_token_transport IN ('fragment', 'query'))",
    );
    expect(source).toContain("CREATE FUNCTION claim_organization_user_setup_delivery_v2");
    expect(source).toContain("CREATE FUNCTION prepare_organization_user_setup_delivery_v2");
    expect(source).toContain("RENAME TO claim_organization_user_setup_delivery_unfenced_0401");
    expect(source).toContain("CREATE FUNCTION claim_organization_user_setup_delivery(p_command");
    expect(source).toContain(
      "opengeni_private.claim_organization_user_setup_delivery_unfenced_0401",
    );
    expect(source).toContain(
      "query-frozen organization setup delivery requires a 0401-aware API replica",
    );
    expect(source).toContain("result := prepare_organization_user_setup_delivery(p_command)");
    expect(source).toContain(
      "setup_token_transport = coalesce(setup_token_transport, setup_token_transport_value)",
    );
    expect(source).toContain("organization setup delivery transport changed under retry");
    expect(source).toContain(
      "GRANT EXECUTE ON FUNCTION %I.claim_organization_user_setup_delivery_v2(jsonb) TO opengeni_app",
    );
    expect(source).toContain(
      "GRANT EXECUTE ON FUNCTION %I.prepare_organization_user_setup_delivery_v2(jsonb) TO opengeni_app",
    );
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION claim_organization_user_setup_delivery_v2(jsonb) FROM PUBLIC",
    );
    expect(source).toContain(
      "claim_organization_user_setup_delivery_unfenced_0401(jsonb) FROM PUBLIC",
    );
    expect(source).toContain(
      "claim_organization_user_setup_delivery_unfenced_0401(jsonb)\n      FROM opengeni_app",
    );
    expect(source).not.toMatch(
      /UPDATE organization_user_setup_deliveries SET\s+setup_token_transport = '(?:fragment|query)'/u,
    );
  });
});
