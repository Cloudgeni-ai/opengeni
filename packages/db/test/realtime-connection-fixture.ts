import type {
  McpConnectionAccountBinding,
  McpPersonalConnectionDelegation,
} from "@opengeni/contracts";
import { createConnection, encryptEnvironmentValue, type Database } from "../src/index";

export async function realtimeConnectionFixture(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    ownerSubjectId: string;
  },
) {
  const { accountId, workspaceId, ownerSubjectId } = input;
  const connection = await createConnection(db, {
    accountId,
    workspaceId,
    subjectId: ownerSubjectId,
    providerDomain: "mcp.example.test",
    kind: "oauth2",
    credentialEncrypted: encryptEnvironmentValue(
      Buffer.alloc(32, 19),
      JSON.stringify({ access_token: "fixture-only" }),
    ),
    createdBySubjectId: ownerSubjectId,
  });
  const connectionId = connection.id;
  const serverId = `account-${connectionId.replaceAll("-", "")}`;
  const binding: McpConnectionAccountBinding = {
    serverId,
    canonicalServerId: "personal-test",
    connectionId,
    originWorkspaceId: workspaceId,
    ownerSubjectId,
    subjectScope: "subject",
    providerDomain: "mcp.example.test",
    kind: "oauth2",
    accountLabel: "Only me",
    connectionRef: {
      kind: "oauth2",
      connectionId,
      providerDomain: "mcp.example.test",
      subjectScope: "subject",
    },
    ...(connection.connectionAuthorityGeneration
      ? { connectionAuthorityGeneration: connection.connectionAuthorityGeneration }
      : {}),
  };
  const delegation: McpPersonalConnectionDelegation = {
    serverId,
    canonicalServerId: binding.canonicalServerId,
    connectionId,
    originWorkspaceId: workspaceId,
    ownerSubjectId,
    providerDomain: binding.providerDomain,
    kind: binding.kind,
    connectionType: "mcp",
  };
  return { mcpAccountBindings: [binding], personalConnectionDelegations: [delegation] };
}
