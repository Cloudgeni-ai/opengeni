import { describe, expect, test } from "bun:test";
import type { AccessContext, Workspace } from "@opengeni/sdk";

import {
  consoleEditableArtifactReplicaStorageKey,
  createConsoleEditableArtifactAuthority,
  getOrCreateConsoleEditableArtifactReplicaId,
} from "./editable-artifact-browser";

const workspace = {
  id: "ba07f804-5df7-453f-941c-8ce3e21e4923",
  accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Artifacts",
  slug: null,
  externalSource: null,
  externalId: null,
  agentInstructions: null,
  settings: {},
  inferenceControl: {
    state: "active",
    revision: 1,
    reason: null,
    changedBy: null,
    changedAt: null,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies Workspace;

function access(subjectId = "user:one"): AccessContext {
  return {
    mode: "managed",
    subjectId,
    workspaceGrants: [
      {
        workspaceId: workspace.id,
        accountId: workspace.accountId,
        subjectId,
        permissions: ["artifacts:read", "artifacts:publish"],
        principalKind: "human_session",
      },
    ],
    accountGrants: [],
    defaultAccountId: workspace.accountId,
    defaultWorkspaceId: workspace.id,
  } satisfies AccessContext;
}

describe("editable artifact browser identity", () => {
  test("partitions cache authority by principal and rotates the authorization epoch", async () => {
    const first = await createConsoleEditableArtifactAuthority({
      deploymentOrigin: "https://api.example.test/path",
      workspace,
      accessContext: access(),
      accessKeyVersion: 1,
    });
    const rotated = await createConsoleEditableArtifactAuthority({
      deploymentOrigin: "https://api.example.test/other",
      workspace,
      accessContext: access(),
      accessKeyVersion: 2,
    });
    const otherPrincipal = await createConsoleEditableArtifactAuthority({
      deploymentOrigin: "https://api.example.test",
      workspace,
      accessContext: access("user:two"),
      accessKeyVersion: 1,
    });

    expect(first.deploymentOrigin).toBe("https://api.example.test");
    expect(rotated.authorizationEpoch).not.toBe(first.authorizationEpoch);
    expect(otherPrincipal.principalId).not.toBe(first.principalId);
  });

  test("reuses one valid replica only inside the same principal partition", async () => {
    const firstAuthority = await createConsoleEditableArtifactAuthority({
      deploymentOrigin: "https://api.example.test",
      workspace,
      accessContext: access(),
      accessKeyVersion: 1,
    });
    const secondAuthority = await createConsoleEditableArtifactAuthority({
      deploymentOrigin: "https://api.example.test",
      workspace,
      accessContext: access("user:two"),
      accessKeyVersion: 1,
    });
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    const artifactId = "a".repeat(32);
    const first = getOrCreateConsoleEditableArtifactReplicaId({
      authority: firstAuthority,
      artifactId,
      storage,
      createReplicaId: () => "1111111111111111",
    });
    const replay = getOrCreateConsoleEditableArtifactReplicaId({
      authority: firstAuthority,
      artifactId,
      storage,
      createReplicaId: () => "2222222222222222",
    });
    const second = getOrCreateConsoleEditableArtifactReplicaId({
      authority: secondAuthority,
      artifactId,
      storage,
      createReplicaId: () => "3333333333333333",
    });

    expect(first).toBe("1111111111111111");
    expect(replay).toBe(first);
    expect(second).toBe("3333333333333333");
    expect(consoleEditableArtifactReplicaStorageKey(firstAuthority, artifactId)).not.toBe(
      consoleEditableArtifactReplicaStorageKey(secondAuthority, artifactId),
    );
  });

  test("fails closed for mismatched grants, malformed IDs, and unavailable storage", async () => {
    await expect(
      createConsoleEditableArtifactAuthority({
        deploymentOrigin: "https://api.example.test",
        workspace,
        accessContext: { ...access(), workspaceGrants: [] },
        accessKeyVersion: 1,
      }),
    ).rejects.toThrow("do not have access");

    const authority = await createConsoleEditableArtifactAuthority({
      deploymentOrigin: "https://api.example.test",
      workspace,
      accessContext: access(),
      accessKeyVersion: 1,
    });
    expect(() =>
      getOrCreateConsoleEditableArtifactReplicaId({
        authority,
        artifactId: "not-an-id",
        storage: { getItem: () => null, setItem: () => undefined },
      }),
    ).toThrow("malformed");
    expect(() =>
      getOrCreateConsoleEditableArtifactReplicaId({
        authority,
        artifactId: "b".repeat(32),
        storage: { getItem: () => null, setItem: () => undefined },
        createReplicaId: () => "0000000000000000",
      }),
    ).toThrow("writer identity");
    expect(() =>
      getOrCreateConsoleEditableArtifactReplicaId({
        authority,
        artifactId: "b".repeat(32),
        storage: {
          getItem: () => {
            throw new Error("blocked");
          },
          setItem: () => undefined,
        },
      }),
    ).toThrow("Browser storage is required");
  });
});
