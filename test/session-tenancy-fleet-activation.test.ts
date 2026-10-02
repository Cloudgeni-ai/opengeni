import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../packages/db/src/lossless-json";
import {
  activationConnectionOptions,
  activationScope,
  activateSessionTenancyTransaction,
  assertSessionTenancyApplicationRolesDrained,
  FLEET_MIGRATION,
  FLEET_PREPARATION_MIGRATION,
  requiredActivationMigrations,
} from "../scripts/activate-session-tenancy";

const id = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";

describe("session tenancy fleet activation admission", () => {
  test("the actual CLI connection carries the canonical current protocol and preserves schema selection", () => {
    expect(activationConnectionOptions()).toEqual({
      max: 1,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    expect(activationConnectionOptions("embedded_fixture")).toEqual({
      max: 1,
      connection: {
        application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME,
        search_path: "embedded_fixture",
      },
    });
  });
  test("admits exactly one activation scope and rejects preference overrides", () => {
    expect(activationScope(["--organization-id", id])).toEqual({
      organizationId: id,
      allOrganizations: false,
    });
    expect(activationScope(["--all-organizations"])).toEqual({
      organizationId: null,
      allOrganizations: true,
    });
    for (const args of [
      [],
      ["--all-organizations", "--enable-organization-private-sessions"],
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

  test("the fleet marker requires the drained maintenance release path", () => {
    const marker = readFileSync(
      new URL(`../packages/db/drizzle/${FLEET_MIGRATION}`, import.meta.url),
      "utf8",
    );
    expect(marker.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
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

  test("preserves missing, OFF and ON preferences while verifying every existing receipt", async () => {
    const missingSettingId = "00000000-0000-4000-8000-000000000003";
    const settings = new Map([
      [id, { enabled: false, revision: 7 }],
      [secondId, { enabled: true, revision: 9 }],
    ]);
    const originalSettings = JSON.stringify([...settings]);
    const checked: string[] = [];
    const queryLog: string[] = [];
    const transaction = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      queryLog.push(query);
      if (query.includes("schema_migrations"))
        return requiredActivationMigrations(true).map((name) => ({ name }));
      if (query.includes("pg_catalog.pg_roles")) return [{ name: "opengeni_app" }];
      if (query.includes("pg_catalog.pg_stat_clear_snapshot")) return [];
      if (query.includes("pg_catalog.pg_stat_activity")) return [{ connected: false }];
      if (query.includes("select id from managed_accounts"))
        return [{ id }, { id: secondId }, { id: missingSettingId }];
      if (
        query.includes("enable_organization_private_sessions_from_activation") ||
        query.includes("organization_private_session_settings")
      )
        throw new Error("Activation must not read or mutate organization preferences");
      if (query.includes("session_tenancy_product_activated")) {
        checked.push(String(values[0]));
        return [{ activated: true }];
      }
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
      organizationCount: 3,
      alreadyActivated: 3,
      newlyActivated: 0,
    });
    expect(queryLog[0]).toContain("lock table managed_accounts in share mode");
    expect(checked).toEqual([id, secondId, missingSettingId, id, secondId, missingSettingId]);
    expect(JSON.stringify([...settings])).toBe(originalSettings);
    expect(queryLog.some((query) => query.includes("update sessions"))).toBe(false);
  });

  test("does not return success when final activation coverage drifts", async () => {
    let checks = 0;
    const transaction = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("schema_migrations"))
        return requiredActivationMigrations(true).map((name) => ({ name }));
      if (query.includes("pg_catalog.pg_roles")) return [{ name: "opengeni_app" }];
      if (query.includes("pg_catalog.pg_stat_clear_snapshot")) return [];
      if (query.includes("pg_catalog.pg_stat_activity")) return [{ connected: false }];
      if (query.includes("select id from managed_accounts")) return [{ id }];
      if (query.includes("session_tenancy_product_activated"))
        return [{ activated: ++checks === 1 }];
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

  test("rejects nonexistent or privileged application login roles before sampling activity", async () => {
    const transaction = (async (strings: TemplateStringsArray) => {
      if (strings.join("?").includes("pg_catalog.pg_roles")) return [];
      throw new Error("must reject invalid roles before sampling activity");
    }) as unknown as postgres.TransactionSql;
    await expect(
      assertSessionTenancyApplicationRolesDrained(transaction, ["opengeni_app"]),
    ).rejects.toThrow("restricted application login roles");
  });

  test("a live application blocks even a replay-only fleet before organization admission", async () => {
    const transaction = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("schema_migrations"))
        return requiredActivationMigrations(true).map((name) => ({ name }));
      if (query.includes("pg_catalog.pg_roles")) return [{ name: "opengeni_app" }];
      if (query.includes("pg_catalog.pg_stat_clear_snapshot") || query.includes("lock table"))
        return [];
      if (query.includes("pg_catalog.pg_stat_activity")) return [{ connected: true }];
      throw new Error("must reject the live application before organization admission");
    }) as unknown as postgres.TransactionSql;
    await expect(
      activateSessionTenancyTransaction(transaction, {
        organizationId: null,
        allOrganizations: true,
        activatedBy: "test",
        roles: ["opengeni_app"],
      }),
    ).rejects.toThrow("every application role session to be stopped");
  });

  test("the final fresh snapshot rejects a late reconnect hidden by the initial activity snapshot", async () => {
    let connected = false;
    let cachedActivity: boolean | null = null;
    let snapshotsCleared = 0;
    let receiptChecks = 0;
    const transaction = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("schema_migrations"))
        return requiredActivationMigrations(true).map((name) => ({ name }));
      if (query.includes("pg_catalog.pg_roles")) return [{ name: "opengeni_app" }];
      if (query.includes("pg_catalog.pg_stat_clear_snapshot")) {
        cachedActivity = null;
        snapshotsCleared += 1;
        return [];
      }
      if (query.includes("pg_catalog.pg_stat_activity")) {
        cachedActivity ??= connected;
        return [{ connected: cachedActivity }];
      }
      if (query.includes("select id from managed_accounts")) return [{ id }];
      if (query.includes("session_tenancy_product_activated")) {
        if (++receiptChecks === 2) connected = true;
        return [{ activated: true }];
      }
      if (
        query.includes("enable_organization_private_sessions") ||
        query.includes("organization_private_session_settings")
      )
        throw new Error("must not change organization preferences");
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
    ).rejects.toThrow("every application role session to be stopped");
    expect(snapshotsCleared).toBe(2);
  });
});
