import { expect, test } from "bun:test";
import { connectionMetadataMatchesBinding } from "../src/connection-token-resolver";

const ORIGIN = "https://contoso.crm17.dynamics.com";
const ROOT = `${ORIGIN}/api/data/v9.2`;
const ref = {
  providerDomain: "contoso.crm17.dynamics.com",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
};
const connection = {
  providerDomain: ref.providerDomain,
  kind: "oauth2",
  grantedScopes: [],
  metadata: { mcpUrl: `${ORIGIN}/api/mcp` },
} as any;

test("a Dataverse grant reaches its environment's Web API, never a path outside it", () => {
  for (const url of [`${ROOT}/accounts`, `${ROOT}/accounts?$top=1`, `${ROOT}/$metadata`])
    expect(connectionMetadataMatchesBinding(connection, ref, url)).toBe(true);
  for (const url of [
    `${ORIGIN}/api/data/v9.1/accounts`,
    `https://other.crm17.dynamics.com/api/data/v9.2/accounts`,
    // Traversal out of the Web API root, encoded in any case.
    `${ROOT}/..%2F..%2Fx`,
    `${ROOT}/accounts%2f..%2f..%2fx`,
    `${ROOT}/..%5C..%5Cx`,
    `${ROOT}/%2E%2E/%2e%2e/x`,
  ])
    expect(connectionMetadataMatchesBinding(connection, ref, url)).toBe(false);
});
