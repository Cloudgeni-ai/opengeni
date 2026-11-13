import { expect, test } from "bun:test";
import { connectionMetadataMatchesBinding } from "../src/connection-token-resolver";

const TENANT = "017dcee4-abab-4d45-9546-a26f65d15431";
const ROOT = `https://api.businesscentral.dynamics.com/v2.0/${TENANT}/Production/api/v2.0`;
const ref = {
  providerDomain: "api.businesscentral.dynamics.com",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
};
const connection = {
  providerDomain: ref.providerDomain,
  kind: "oauth2",
  grantedScopes: [],
  metadata: { mcpUrl: ROOT },
} as any;

test("a Business Central grant reaches the Business Central API of any environment, nothing else", () => {
  for (const url of [
    `${ROOT}/companies`,
    `${ROOT}/companies(4ebe426c-34d7-f111-9262-7ced8db421e2)/customers?$top=1`,
    `${ROOT}/$metadata`,
    // Another environment of the same Entra resource.
    `https://api.businesscentral.dynamics.com/v2.0/${TENANT}/Sandbox/api/v2.0/companies`,
  ])
    expect(connectionMetadataMatchesBinding(connection, ref, url)).toBe(true);
  for (const url of [
    "https://api.businesscentral.dynamics.com/other",
    "https://mcp.businesscentral.dynamics.com/",
    `https://api.businesscentral.dynamics.com:444/v2.0/${TENANT}/Production/api/v2.0/companies`,
    `https://user@api.businesscentral.dynamics.com/v2.0/${TENANT}/Production/api/v2.0/companies`,
    "https://attacker.test/v2.0/x/Production/api/v2.0/companies",
  ])
    expect(connectionMetadataMatchesBinding(connection, ref, url)).toBe(false);
  // Only a Business Central connection's grant, and only for an OAuth reference.
  expect(
    connectionMetadataMatchesBinding(
      { ...connection, metadata: { mcpUrl: "https://contoso.crm17.dynamics.com/api/mcp" } },
      ref,
      `${ROOT}/companies`,
    ),
  ).toBe(false);
  expect(
    connectionMetadataMatchesBinding(
      { ...connection, kind: "api_key" },
      { ...ref, kind: "api_key" as any },
      `${ROOT}/companies`,
    ),
  ).toBe(false);
});
