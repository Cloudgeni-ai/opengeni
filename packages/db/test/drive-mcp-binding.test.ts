import { expect, test } from "bun:test";
import { connectionMetadataMatchesBinding } from "../src/connection-token-resolver";
const resource = "https://drivemcp.googleapis.com/mcp/v1";
const ref = {
  providerDomain: "drivemcp.googleapis.com",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
  resource,
};
const connection = {
  providerDomain: ref.providerDomain,
  kind: "oauth2",
  grantedScopes: [],
  metadata: { mcpUrl: resource, resource },
} as any;
test("Drive supplemental API access is confined to the exact personal MCP grant", () => {
  for (const path of [
    "/drive/v3/files/file_1",
    "/drive/v3/files/file_1/permissions",
    "/drive/v3/files/file_1/permissions/user_1",
    "/upload/drive/v3/files/file_1",
    "/drive/v3/changes",
    "/drive/v3/changes/startPageToken",
  ]) {
    expect(
      connectionMetadataMatchesBinding(connection, ref, `https://www.googleapis.com${path}`),
    ).toBe(true);
  }
  for (const url of [
    "https://www.googleapis.com/drive/v3/about",
    "https://www.googleapis.com/gmail/v1/users/me/messages",
    "https://www.googleapis.com:444/drive/v3/files/file_1",
    "https://attacker.test/drive/v3/files/file_1",
    "http://www.googleapis.com/drive/v3/files/file_1",
  ]) {
    expect(connectionMetadataMatchesBinding(connection, ref, url)).toBe(false);
  }
  expect(
    connectionMetadataMatchesBinding(
      connection,
      { ...ref, subjectScope: "workspace" },
      "https://www.googleapis.com/drive/v3/files/file_1",
    ),
  ).toBe(false);
  expect(
    connectionMetadataMatchesBinding(
      { ...connection, metadata: { mcpUrl: "https://other.example/mcp" } },
      ref,
      "https://www.googleapis.com/drive/v3/files/file_1",
    ),
  ).toBe(false);
});
