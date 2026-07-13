import { dbSearchPath, getSettings } from "@opengeni/config";
import type { ApiKey, Permission, Workspace } from "@opengeni/contracts";
import { createApiKey, createDb, getWorkspace, listApiKeys, revokeApiKey } from "@opengeni/db";
import { dirname } from "node:path";
import { lstat, mkdir, open } from "node:fs/promises";
import { parseArgs as parseNodeArgs } from "node:util";

export const releaseSentinelPermissions: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "terminal:attach",
];

export interface ReleaseSentinelKeyBootstrapDependencies {
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  listApiKeys(workspaceId: string): Promise<ApiKey[]>;
  revokeApiKey(workspaceId: string, apiKeyId: string): Promise<ApiKey>;
  createApiKey(input: {
    accountId: string;
    workspaceId: string;
    name: string;
    prefix: string;
    keyHash: string;
    permissions: Permission[];
  }): Promise<ApiKey>;
  token(): string;
  sha256(value: string): Promise<string>;
}

export interface ReleaseSentinelKeyBootstrapResult {
  version: 1;
  workspaceId: string;
  apiKeyId: string;
  apiKeyName: string;
  permissions: Permission[];
  token: string;
  rotatedKeyIds: string[];
  createdAt: string;
}

export async function bootstrapReleaseSentinelKey(
  deps: ReleaseSentinelKeyBootstrapDependencies,
  input: { workspaceId: string; name?: string; now?: string },
): Promise<ReleaseSentinelKeyBootstrapResult> {
  const workspaceId = uuid(input.workspaceId);
  const name = input.name ?? "OpenGeni release sentinel";
  if (name.length < 3 || name.length > 100) throw new Error("sentinel API key name is invalid");
  const workspace = await deps.getWorkspace(workspaceId);
  if (!workspace || workspace.id !== workspaceId)
    throw new Error("sentinel workspace does not exist");

  const existing = (await deps.listApiKeys(workspaceId)).filter(
    (key) => key.name === name && !key.revokedAt,
  );
  const rotatedKeyIds: string[] = [];
  for (const key of existing) {
    await deps.revokeApiKey(workspaceId, key.id);
    rotatedKeyIds.push(key.id);
  }

  const token = deps.token();
  if (!/^ogk_[0-9a-f]{64}$/.test(token)) throw new Error("generated sentinel token is invalid");
  const created = await deps.createApiKey({
    accountId: workspace.accountId,
    workspaceId,
    name,
    prefix: token.slice(0, 14),
    keyHash: await deps.sha256(token),
    permissions: [...releaseSentinelPermissions],
  });
  const createdAt = input.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("sentinel key creation time is invalid");
  return {
    version: 1,
    workspaceId,
    apiKeyId: created.id,
    apiKeyName: name,
    permissions: [...releaseSentinelPermissions],
    token,
    rotatedKeyIds,
    createdAt,
  };
}

async function main(): Promise<void> {
  const { values } = parseNodeArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    strict: true,
    options: {
      "workspace-id": { type: "string" },
      out: { type: "string" },
    },
  });
  const workspaceId = uuid(required(values["workspace-id"], "--workspace-id"));
  const out = required(values.out, "--out");
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
  });
  try {
    const result = await bootstrapReleaseSentinelKey(
      {
        getWorkspace: async (id) => await getWorkspace(client.db, id),
        listApiKeys: async (id) => await listApiKeys(client.db, id),
        revokeApiKey: async (id, apiKeyId) => await revokeApiKey(client.db, id, apiKeyId),
        createApiKey: async (input) => await createApiKey(client.db, input),
        token: generateApiKeyToken,
        sha256: sha256Hex,
      },
      { workspaceId },
    );
    await writePrivateJsonFile(out, result);
    // Never print the token. The protected bootstrap workflow copies `out`
    // directly from the temporary Pod into a Kubernetes Secret.
    console.log(
      JSON.stringify({
        ok: true,
        version: result.version,
        workspaceId: result.workspaceId,
        apiKeyId: result.apiKeyId,
        apiKeyName: result.apiKeyName,
        permissions: result.permissions,
        rotatedKeyCount: result.rotatedKeyIds.length,
        tokenWrittenToPrivateFile: true,
      }),
    );
  } finally {
    await client.close();
  }
}

export async function writePrivateJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // `wx` is deliberately exclusive: an existing path or symlink must not be
  // followed or overwritten with a newly minted bearer. The file descriptor
  // is private before the first byte is written, independent of the caller's
  // umask, and fsync completes before the workflow observes process success.
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("sentinel bearer output is not a private regular file");
  }
}

function generateApiKeyToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `ogk_${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("workspace ID must be a canonical UUID");
  }
  return value;
}

if (import.meta.main) {
  await main();
}
