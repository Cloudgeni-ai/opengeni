import { expect, test } from "bun:test";
import {
  OPENROUTER_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY,
  OPENROUTER_CREDENTIAL_OPERATION_ID_METADATA_KEY,
  VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY,
  VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_ID_METADATA_KEY,
} from "@opengeni/contracts";
import { mapConnectionMetadata } from "../src/connection-metadata";

function metadataRow() {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "connection",
    authorityId: "owner-authority",
    authorityGeneration: 3,
    accountId: "organization",
    workspaceId: "home-workspace",
    subjectId: "user:owner" as string | null,
    providerDomain: "slack.com",
    kind: "app_install",
    status: "active",
    grantedScopes: ["chat:write"],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: timestamp,
    lastError: null,
    version: 4,
    verifiedInstallAt: timestamp,
    verifiedInstallVersion: 4,
    metadata: {
      label: "Public label",
      [OPENROUTER_CREDENTIAL_OPERATION_ID_METADATA_KEY]: "private-operation",
      [OPENROUTER_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY]: "private-digest",
      [VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_ID_METADATA_KEY]: "private-operation",
      [VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY]: "private-digest",
      anthropicCredentialOperationId: "private-operation",
      anthropicCredentialOperationDigest: "private-digest",
      claude_subscriptionCredentialOperationId: "private-operation",
      claude_subscriptionCredentialOperationDigest: "private-digest",
    },
    createdBySubjectId: "user:owner",
    updatedBySubjectId: "user:owner",
    createdAt: timestamp,
    updatedAt: timestamp,
    credentialEncrypted: "must-not-project",
  };
}

test("metadata leaf preserves verification and owner authority without credential operation data", () => {
  const row = metadataRow();
  const projected = mapConnectionMetadata(row);
  expect(projected.metadata).toEqual({ label: "Public label" });
  expect(projected).not.toHaveProperty("credentialEncrypted");
  expect(projected).toMatchObject({
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    subjectId: row.subjectId,
    authorityId: row.authorityId,
    connectionAuthorityGeneration: 3,
    version: 4,
    verifiedInstallVersion: 4,
    verifiedInstallAt: row.verifiedInstallAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    expiresAt: null,
  });
  expect(row.metadata.anthropicCredentialOperationId).toBe("private-operation");
});

test("workspace-shared metadata never projects a personal authority ID", () => {
  expect(mapConnectionMetadata({ ...metadataRow(), subjectId: null })).not.toHaveProperty(
    "authorityId",
  );
});
