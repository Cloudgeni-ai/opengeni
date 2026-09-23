import { expect, test } from "bun:test";
import {
  organizationIntegrationCatalog,
  integrationKeyForConnectProvider,
  integrationSourceForOrganizationPolicy,
} from "../src/domain/organization-integration-catalog";

test("policy catalog gives stable distinct service identities and explicit custom categories", () => {
  const catalog = organizationIntegrationCatalog();
  const keys = catalog.integrations.map((item) => item.key);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys).toContain("microsoft-outlook-mail");
  expect(keys).toContain("microsoft-outlook-calendar");
  expect(
    catalog.integrations
      .filter((item) => item.kind === "custom")
      .map((item) => item.key)
      .sort(),
  ).toEqual(["custom:graphql", "custom:mcp", "custom:openapi"]);
  expect(catalog.integrations.every((item) => item.label.length > 0)).toBe(true);
});

test("source detection only probes permitted protocols and never promotes custom URLs", () => {
  const source = { kind: "auto" as const, url: "https://graph.microsoft.com/schema" };
  const policy = (allowedIntegrationKeys: string[]) => ({
    mode: "restricted" as const,
    revision: 1,
    allowedIntegrationKeys,
  });
  expect(() =>
    integrationSourceForOrganizationPolicy(policy(["microsoft-outlook-mail"]), source),
  ).toThrow();
  expect(integrationSourceForOrganizationPolicy(policy(["custom:openapi"]), source)).toEqual({
    kind: "openapi",
    url: source.url,
  });
  expect(integrationSourceForOrganizationPolicy(policy(["custom:graphql"]), source)).toEqual({
    kind: "graphql",
    endpoint: source.url,
  });
  expect(
    integrationSourceForOrganizationPolicy(policy(["custom:graphql", "custom:openapi"]), source),
  ).toEqual(source);
  expect(() =>
    integrationSourceForOrganizationPolicy(policy(["fake"]), {
      kind: "definition",
      definitionId: "fake",
    }),
  ).toThrow();
  expect(
    integrationSourceForOrganizationPolicy(policy(["microsoft-outlook-mail"]), {
      kind: "definition",
      definitionId: "microsoft-outlook-mail",
    }),
  ).toEqual({ kind: "definition", definitionId: "microsoft-outlook-mail" });
});

test("adapter classification never treats arbitrary IDs or domains as curated services", () => {
  expect(integrationKeyForConnectProvider("microsoft-outlook-mail")).toBe("microsoft-outlook-mail");
  expect(integrationKeyForConnectProvider("mcp-headers")).toBe("custom:mcp");
  expect(integrationKeyForConnectProvider("openapi")).toBe("custom:openapi");
  expect(integrationKeyForConnectProvider("graphql")).toBe("custom:graphql");
  expect(integrationKeyForConnectProvider("fiken-token")).toBe("fiken");
  expect(integrationKeyForConnectProvider("fiken-oauth")).toBe("fiken");
  expect(integrationKeyForConnectProvider("graph.microsoft.com")).toBeNull();
  expect(integrationKeyForConnectProvider("unregistered-adapter")).toBeNull();
});
