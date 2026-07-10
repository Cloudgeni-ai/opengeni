import { describe, expect, it } from "bun:test";
import type { ApiKey, Workspace } from "@opengeni/contracts";
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapReleaseSentinelKey,
  releaseSentinelPermissions,
  writePrivateJsonFile,
  type ReleaseSentinelKeyBootstrapDependencies,
} from "./release-sentinel-key-bootstrap";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";

describe("release sentinel key bootstrap", () => {
  it("rotates a lost prior key and creates one exact least-privilege identity", async () => {
    const revoked: string[] = [];
    const created: Parameters<ReleaseSentinelKeyBootstrapDependencies["createApiKey"]>[0][] = [];
    const result = await bootstrapReleaseSentinelKey(deps({ revoked, created }), {
      workspaceId,
      now: "2026-07-10T00:00:00Z",
    });
    expect(revoked).toEqual(["old-key"]);
    expect(created).toHaveLength(1);
    expect(created[0]?.permissions).toEqual(releaseSentinelPermissions);
    expect(result.permissions).toEqual([
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "terminal:attach",
    ]);
    expect(result.token).toMatch(/^ogk_[0-9a-f]{64}$/);
    expect(result.rotatedKeyIds).toEqual(["old-key"]);
  });

  it("fails before mutation for an unknown workspace or malformed token", async () => {
    const missing = deps();
    missing.getWorkspace = async () => null;
    await expect(bootstrapReleaseSentinelKey(missing, { workspaceId })).rejects.toThrow(
      "does not exist",
    );

    const malformed = deps();
    malformed.token = () => "not-a-key";
    await expect(bootstrapReleaseSentinelKey(malformed, { workspaceId })).rejects.toThrow(
      "generated sentinel token",
    );
  });

  it("creates bearer output as an exclusive 0600 regular file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengeni-release-sentinel-"));
    try {
      const path = join(directory, "identity.json");
      await writePrivateJsonFile(path, { token: "private" });
      const stat = await lstat(path);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o600);
      await expect(writePrivateJsonFile(path, { token: "replacement" })).rejects.toThrow();

      const symlinkPath = join(directory, "identity-link.json");
      await symlink(path, symlinkPath);
      await expect(writePrivateJsonFile(symlinkPath, { token: "replacement" })).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function deps(
  state: {
    revoked?: string[];
    created?: Parameters<ReleaseSentinelKeyBootstrapDependencies["createApiKey"]>[0][];
  } = {},
): ReleaseSentinelKeyBootstrapDependencies {
  const workspace = { id: workspaceId, accountId } as Workspace;
  const prior = {
    id: "old-key",
    name: "OpenGeni release sentinel",
    revokedAt: null,
  } as ApiKey;
  return {
    getWorkspace: async () => workspace,
    listApiKeys: async () => [prior],
    revokeApiKey: async (_workspaceId, id) => {
      state.revoked?.push(id);
      return { ...prior, revokedAt: "2026-07-10T00:00:00Z" } as ApiKey;
    },
    createApiKey: async (input) => {
      state.created?.push(input);
      return { id: "new-key", name: input.name, revokedAt: null } as ApiKey;
    },
    token: () => `ogk_${"a".repeat(64)}`,
    sha256: async () => "b".repeat(64),
  };
}
