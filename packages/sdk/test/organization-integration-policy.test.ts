import { expect, test } from "bun:test";
import {
  getOrganizationIntegrationCatalog,
  getOrganizationIntegrationPolicy,
  updateOrganizationIntegrationPolicy,
} from "../src/organization-integration-policy";

test("organization integration identities are discoverable through the authenticated catalog", async () => {
  const calls: unknown[][] = [];
  const catalog = {
    integrations: [{ key: "custom:mcp", label: "Custom MCP servers", kind: "custom" as const }],
  };
  const client = {
    async requestJson<T>(...args: unknown[]): Promise<T> {
      calls.push(args);
      return catalog as T;
    },
  };
  const organizationId = "11111111-1111-4111-8111-111111111111";
  expect(await getOrganizationIntegrationCatalog(client, organizationId)).toEqual(catalog);
  expect(calls).toEqual([
    ["GET", `/v1/organizations/${organizationId}/integration-policy/catalog`],
  ]);
});

test("organization policy reads and writes preserve the explicit organization and operation", async () => {
  const calls: unknown[][] = [];
  const policy = { mode: "restricted" as const, allowedIntegrationKeys: [], revision: 1 };
  const client = {
    async requestJson<T>(...args: unknown[]): Promise<T> {
      calls.push(args);
      return policy as T;
    },
  };
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const request = {
    mode: "restricted" as const,
    allowedIntegrationKeys: [],
    expectedRevision: 0,
    operationId: "22222222-2222-4222-8222-222222222222",
  };
  expect(await getOrganizationIntegrationPolicy(client, organizationId)).toEqual(policy);
  expect(await updateOrganizationIntegrationPolicy(client, organizationId, request)).toEqual(
    policy,
  );
  expect(calls).toEqual([
    ["GET", `/v1/organizations/${organizationId}/integration-policy`],
    ["PUT", `/v1/organizations/${organizationId}/integration-policy`, request],
  ]);
});

test("an uncertain policy mutation is not automatically replayed", async () => {
  let calls = 0;
  const failure = new Error("Connection interrupted");
  const client = {
    async requestJson<T>(): Promise<T> {
      calls += 1;
      throw failure;
    },
  };
  await expect(
    updateOrganizationIntegrationPolicy(client, "11111111-1111-4111-8111-111111111111", {
      mode: "unrestricted",
      allowedIntegrationKeys: [],
      expectedRevision: 1,
      operationId: "22222222-2222-4222-8222-222222222222",
    }),
  ).rejects.toBe(failure);
  expect(calls).toBe(1);
});
