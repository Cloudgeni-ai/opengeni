import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { activationScope, requiredActivationMigrations } from "../scripts/activate-session-tenancy";

const id = "00000000-0000-4000-8000-000000000001";

describe("session tenancy fleet activation admission", () => {
  test("requires exactly one of an existing organization or the complete fleet", () => {
    expect(activationScope(["--organization-id", id])).toEqual({
      organizationId: id,
      allOrganizations: false,
    });
    expect(activationScope(["--all-organizations"])).toEqual({
      organizationId: null,
      allOrganizations: true,
    });
    expect(() => activationScope([])).toThrow();
    expect(() => activationScope(["--organization-id", id, "--all-organizations"])).toThrow();
    expect(() => activationScope(["--organization-id", "invalid"])).toThrow();
  });

  test("maintenance marker forces the release's drained path", () => {
    const marker = readFileSync(
      new URL("../packages/db/drizzle/0515_private_sessions_fleet_activation.sql", import.meta.url),
      "utf8",
    );
    expect(marker.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(requiredActivationMigrations(true)).toContain(
      "0515_private_sessions_fleet_activation.sql",
    );
    expect(requiredActivationMigrations(false)).not.toContain(
      "0515_private_sessions_fleet_activation.sql",
    );
  });
});
