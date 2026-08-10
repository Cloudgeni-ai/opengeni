import { describe, expect, test } from "bun:test";

import {
  InstallApiIntegrationRequest,
  IntegrationInstanceKey,
  PluginComponentBinding,
  UninstallApiIntegrationRequest,
} from "../src";

const source = {
  kind: "openapi" as const,
  url: "https://api.example.test/openapi.json",
};

describe("Integration instance contracts", () => {
  test("accepts stable bounded instance keys and rejects mutable display-name syntax as identity", () => {
    expect(IntegrationInstanceKey.safeParse("finance-primary").success).toBe(true);
    expect(IntegrationInstanceKey.safeParse("team/linear.eu").success).toBe(true);
    expect(IntegrationInstanceKey.safeParse("Finance Primary").success).toBe(false);
    expect(IntegrationInstanceKey.safeParse("a".repeat(129)).success).toBe(false);
  });

  test("carries independent create/update and uninstall version fences", () => {
    expect(
      InstallApiIntegrationRequest.safeParse({
        source,
        expectedRevisionId: "openapi:aaaaaaaaaaaaaaaaaaaaaaaa",
        expectedContentSha256: "b".repeat(64),
        connectionId: "00000000-0000-4000-8000-000000000001",
        instanceKey: "finance",
        displayName: "Gmail — Finance",
        expectedInstanceVersion: 3,
      }).success,
    ).toBe(true);
    expect(
      UninstallApiIntegrationRequest.safeParse({
        expectedInstallationVersion: 7,
        expectedInstanceVersion: 3,
      }).success,
    ).toBe(true);
    expect(
      UninstallApiIntegrationRequest.safeParse({ expectedInstallationVersion: 7 }).success,
    ).toBe(false);
  });

  test("lets Plugin callers name a binding without embedding credentials", () => {
    expect(
      PluginComponentBinding.safeParse({
        connectionId: "00000000-0000-4000-8000-000000000002",
        instanceKey: "product-linear",
        displayName: "Linear — Product",
      }).success,
    ).toBe(true);
    expect(
      PluginComponentBinding.safeParse({
        connectionId: "00000000-0000-4000-8000-000000000002",
        instanceKey: "product-linear",
        credential: "must-not-be-accepted",
      }).success,
    ).toBe(false);
  });
});