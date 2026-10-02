import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import {
  activationScope,
  activateSessionTenancyTransaction,
  FLEET_MIGRATION,
  FLEET_PREPARATION_MIGRATION,
  requiredActivationMigrations,
} from "../scripts/activate-session-tenancy";

const id = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";

describe("session tenancy fleet activation admission", () => {
  test("requires explicit fleet permission consent without changing the single-org path", () => {
    expect(activationScope(["--organization-id", id])).toEqual({
      organizationId: id,
      allOrganizations: false,
      enableOrganizationPrivateSessions: false,
    });
    expect(
      activationScope(["--all-organizations", "--enable-organization-private-sessions"]),
    ).toEqual({
      organizationId: null,
      allOrganizations: true,
      enableOrganizationPrivateSessions: true,
    });
    for (const args of [
      [],
      ["--all-organizations"],
      ["--organization-id", "invalid"],
      ["--organization-id", id, "--all-organizations"],
      ["--organization-id", id, "--enable-organization-private-sessions"],
    ]) {
      expect(() => activationScope(args)).toThrow();
    }
    expect(requiredActivationMigrations(true)).toContain(FLEET_PREPARATION_MIGRATION);
    expect(requiredActivationMigrations(true)).toContain(FLEET_MIGRATION);
    expect(requiredActivationMigrations(false)).not.toContain(FLEET_MIGRATION);
    expect(requiredActivationMigrations(false)).not.toContain(FLEET_PREPARATION_MIGRATION);
  });

  test("the rolling definitions alone cannot admit the fleet command", async () => {
    const transaction = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("schema_migrations"))
        return requiredActivationMigrations(true)
          .filter((name) => name !== FLEET_MIGRATION)
          .map((name) => ({ name }));
      if (query.includes("lock table managed_accounts")) return [];
      throw new Error("must fail before inspecting or changing an organization");
    }) as unknown as postgres.TransactionSql;
    await expect(
      activateSessionTenancyTransaction(transaction, {
        organizationId: null,
        allOrganizations: true,
        activatedBy: "test",
        roles: ["opengeni_app"],
      }),
    ).rejects.toThrow(FLEET_MIGRATION);
  });

  test("enables and verifies EVERY already-activated org, with drain roles, inside the caller transaction", async () => {
    const enabled: string[] = [];
    const checked: string[] = [];
    const queryLog: string[] = [];
    const transaction = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      queryLog.push(query);
      if (query.includes("schema_migrations"))
        return requiredActivationMigrations(true).map((name) => ({ name }));
      if (query.includes("select id from managed_accounts")) return [{ id }, { id: secondId }];
      if (query.includes("enable_organization_private_sessions_from_activation")) {
        expect(values[1]).toEqual(["opengeni_app"]);
        enabled.push(String(values[0]));
        return [{ setting: { enabled: true, changed: true } }];
      }
      if (query.includes("organization_private_sessions_enabled")) {
        checked.push(String(values[0]));
        return [{ activated: true, enabled: true }];
      }
      if (query.includes("session_tenancy_product_activated")) return [{ activated: true }];
      if (query.includes("lock table") || query.includes("set_config")) return [];
      throw new Error(`Unexpected query: ${query}`);
    }) as unknown as postgres.TransactionSql;
    await expect(
      activateSessionTenancyTransaction(transaction, {
        organizationId: null,
        allOrganizations: true,
        activatedBy: "test",
        roles: ["opengeni_app"],
      }),
    ).resolves.toMatchObject({
      organizationCount: 2,
      alreadyActivated: 2,
      newlyActivated: 0,
      permissionsEnabled: 2,
    });
    expect(queryLog[0]).toContain("lock table managed_accounts in share mode");
    expect(enabled).toEqual([id, secondId]);
    expect(checked).toEqual([id, secondId]);
    expect(queryLog.some((query) => query.includes("update sessions"))).toBe(false);
  });

  test("does not return success when final permission coverage drifts", async () => {
    const transaction = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("schema_migrations"))
        return requiredActivationMigrations(true).map((name) => ({ name }));
      if (query.includes("select id from managed_accounts")) return [{ id }];
      if (query.includes("enable_organization_private_sessions_from_activation"))
        return [{ setting: { enabled: true } }];
      if (query.includes("organization_private_sessions_enabled"))
        return [{ activated: true, enabled: false }];
      if (query.includes("session_tenancy_product_activated")) return [{ activated: true }];
      return [];
    }) as unknown as postgres.TransactionSql;
    await expect(
      activateSessionTenancyTransaction(transaction, {
        organizationId: null,
        allOrganizations: true,
        activatedBy: "test",
        roles: ["opengeni_app"],
      }),
    ).rejects.toThrow("coverage missing");
  });
});
