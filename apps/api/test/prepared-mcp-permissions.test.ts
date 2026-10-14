import { expect, test } from "bun:test";
import { createAttemptToolEnvironment, parseVerifiedAttemptToolCatalog } from "@opengeni/codemode";
import {
  PREPARED_MCP_PERMISSIONS,
  isPreparedMcpConnectPath,
  preparedMcpProxyPermissions,
} from "../src/prepared-mcp-permissions";

const scope = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  turnId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(),
  executionGeneration: 1,
};
const definitions = [
  {
    identity: { serverId: "opengeni", toolName: "custom_mcp_setup_request" },
    modelName: "opengeni__custom_mcp_setup_request",
    description: "Prepared MCP setup",
    inputSchema: { type: "object" },
    source: "mcp" as const,
    approval: "none" as const,
    execute: async () => ({ content: [] }),
  },
];

test("setup SDK permissions require the exact frozen tool and permission set", () => {
  const catalog = createAttemptToolEnvironment({
    scope,
    generation: 1,
    definitions,
    firstPartyMcpPermissions: [...PREPARED_MCP_PERMISSIONS],
  }).catalog;
  expect(preparedMcpProxyPermissions(catalog, PREPARED_MCP_PERMISSIONS)).toEqual([
    ...PREPARED_MCP_PERMISSIONS,
  ]);
  expect(
    preparedMcpProxyPermissions(
      { ...catalog, firstPartyMcpPermissions: [] },
      PREPARED_MCP_PERMISSIONS,
    ),
  ).toEqual([]);
  expect(
    preparedMcpProxyPermissions(
      { ...catalog, firstPartyMcpPermissions: undefined },
      PREPARED_MCP_PERMISSIONS,
    ),
  ).toEqual([]);
  expect(preparedMcpProxyPermissions(catalog, [])).toEqual([]);
  expect(
    preparedMcpProxyPermissions({ ...catalog, entries: [] }, PREPARED_MCP_PERMISSIONS),
  ).toEqual([]);
  expect(
    preparedMcpProxyPermissions(
      { ...catalog, entries: catalog.entries.map((entry) => ({ ...entry, approval: "human" })) },
      PREPARED_MCP_PERMISSIONS,
    ),
  ).toEqual([]);
  expect(() =>
    parseVerifiedAttemptToolCatalog({ ...catalog, firstPartyMcpPermissions: [] }),
  ).toThrow();
});

test("legacy catalogs remain verifiable without gaining setup authority", () => {
  const catalog = createAttemptToolEnvironment({ scope, generation: 1, definitions }).catalog;
  expect(parseVerifiedAttemptToolCatalog(catalog)).toEqual(catalog);
  expect(preparedMcpProxyPermissions(catalog, PREPARED_MCP_PERMISSIONS)).toEqual([]);
});

test("setup proxy authority is restricted to native Connect attempts", () => {
  const base = `/v1/workspaces/${scope.workspaceId}/connect/attempts`;
  expect(isPreparedMcpConnectPath(base, "POST")).toBe(true);
  expect(isPreparedMcpConnectPath(`${base}/${scope.attemptId}/advance`, "POST")).toBe(true);
  expect(isPreparedMcpConnectPath(`${base}/${scope.attemptId}`, "GET")).toBe(true);
  for (const path of [
    "/connections",
    "/capabilities",
    "/connect/accounts",
    "/connect/attempts/../catalog",
  ])
    expect(isPreparedMcpConnectPath(`/v1/workspaces/${scope.workspaceId}${path}`, "POST")).toBe(
      false,
    );
  expect(isPreparedMcpConnectPath(base, "DELETE")).toBe(false);
});
