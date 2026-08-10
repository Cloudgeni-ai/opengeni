import { describe, expect, test } from "bun:test";
import type { AccessContext, Workspace } from "@opengeni/sdk";

import {
  createConsoleEditableArtifactReplicaId,
  createConsoleEditableArtifactAuthority,
  resolveConsoleEditableArtifactWorkerUrl,
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

  test("creates a fresh writer identity for every controller lifetime", () => {
    const ids = ["1111111111111111", "2222222222222222"];
    const createReplicaId = () => ids.shift()!;

    expect(createConsoleEditableArtifactReplicaId(createReplicaId)).toBe("1111111111111111");
    expect(createConsoleEditableArtifactReplicaId(createReplicaId)).toBe("2222222222222222");
  });

  test("resolves bundler-relative Worker assets against the application origin", () => {
    expect(
      resolveConsoleEditableArtifactWorkerUrl(
        "/assets/editable-artifact-worker.js",
        "https://console.example.test/workspaces/one",
      ),
    ).toBe("https://console.example.test/assets/editable-artifact-worker.js");
    expect(
      resolveConsoleEditableArtifactWorkerUrl(
        "https://cdn.example.test/editable-artifact-worker.js",
        "https://console.example.test",
      ),
    ).toBe("https://cdn.example.test/editable-artifact-worker.js");
  });

  test("fails closed for mismatched grants and malformed writer identities", async () => {
    await expect(
      createConsoleEditableArtifactAuthority({
        deploymentOrigin: "https://api.example.test",
        workspace,
        accessContext: { ...access(), workspaceGrants: [] },
        accessKeyVersion: 1,
      }),
    ).rejects.toThrow("do not have access");

    expect(() => createConsoleEditableArtifactReplicaId(() => "0000000000000000")).toThrow(
      "writer identity",
    );
  });
});
