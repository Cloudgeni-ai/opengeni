import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxSessionLike } from "@openai/agents/sandbox";
import { sandboxCommandExitCode } from "./command-result";

/** Data shipped with the worker, never fetched from a package registry at turn time. */
export type ManagedCodemodeClient = {
  version: 1;
  files: { ogtool: string; "client.mjs": string; "package.json": string };
};

export function managedCodemodeClientDigest(client: ManagedCodemodeClient): string {
  return createHash("sha256").update(JSON.stringify(client)).digest("hex");
}

export function managedCodemodeClientDirectory(
  client: ManagedCodemodeClient,
  workspaceRoot = "/workspace",
): string {
  if (!posix.isAbsolute(workspaceRoot) || workspaceRoot.includes("\0")) {
    throw new Error("Managed Codemode client workspace root must be absolute");
  }
  return posix.join(
    workspaceRoot,
    ".opengeni/codemode-clients",
    managedCodemodeClientDigest(client),
  );
}

export async function buildManagedCodemodeClient(root: string): Promise<ManagedCodemodeClient> {
  const bundle = async (entry: string, format: "esm" | "cjs", banner?: string) => {
    const result = await Bun.build({
      entrypoints: [join(root, entry)],
      target: "node",
      format,
      minify: true,
      sourcemap: "none",
      ...(banner ? { banner } : {}),
    });
    if (!result.success || result.outputs.length !== 1) {
      throw new Error(`Managed Codemode client build failed: ${entry}`);
    }
    return await result.outputs[0]!.text();
  };
  return {
    version: 1,
    files: {
      ogtool: await bundle("packages/ogtool/src/cli.ts", "cjs", "#!/usr/bin/env node"),
      "client.mjs": await bundle("packages/codemode/src/index.ts", "esm"),
      // The extensionless executable must not inherit a user's ESM workspace.
      "package.json": '{"type":"commonjs"}\n',
    },
  };
}

let releaseClient: Promise<ManagedCodemodeClient> | undefined;
export function loadManagedCodemodeClient(): Promise<ManagedCodemodeClient> {
  return (releaseClient ??= (async () => {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    // A checkout must not reuse stale dist assets after source changes.
    const root = resolve(moduleDir, "../../../..");
    if (
      import.meta.url.endsWith("/src/sandbox/codemode-client.ts") &&
      existsSync(join(root, "packages/ogtool/src/cli.ts"))
    ) {
      return await buildManagedCodemodeClient(root);
    }
    const candidates = [
      join(moduleDir, "assets/codemode-client.json"),
      join(moduleDir, "../assets/codemode-client.json"),
      join(moduleDir, "../../dist/assets/codemode-client.json"),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      const value = JSON.parse(readFileSync(path, "utf8")) as ManagedCodemodeClient;
      if (
        !value ||
        typeof value !== "object" ||
        value.version !== 1 ||
        Object.keys(value).sort().join(",") !== "files,version" ||
        typeof value.files?.ogtool !== "string" ||
        typeof value.files?.["client.mjs"] !== "string" ||
        value.files?.["package.json"] !== '{"type":"commonjs"}\n' ||
        Object.keys(value.files).sort().join(",") !== "client.mjs,ogtool,package.json"
      ) {
        throw new Error(
          "Invalid deployment-owned managed Codemode client asset; rebuild the worker release",
        );
      }
      return value;
    }
    // Published runtimes must carry their own exact bytes.
    throw new Error(
      "Managed Codemode client asset missing; rebuild and deploy the matching worker/runtime package (do not install latest or replace the sandbox)",
    );
  })());
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Immutable per-release paths permit old/new workers to share a warm box. */
export async function installManagedCodemodeClient(
  session: SandboxSessionLike,
  client: ManagedCodemodeClient,
  run: (cmd: string) => Promise<unknown>,
  runAs?: string,
  workspaceRoot = "/workspace",
): Promise<void> {
  const directory = managedCodemodeClientDirectory(client, workspaceRoot);
  const digest = managedCodemodeClientDigest(client);
  const verify = `
const fs = require('node:fs'), crypto = require('node:crypto');
const root = ${JSON.stringify(directory)};
if (!fs.lstatSync(root).isDirectory()) process.exit(1);
for (const name of ['ogtool', 'client.mjs', 'package.json']) {
  if (!fs.lstatSync(root + '/' + name).isFile()) process.exit(1);
}
fs.accessSync(root + '/ogtool', fs.constants.X_OK);
const files = {ogtool: fs.readFileSync(root + '/ogtool', 'utf8'), 'client.mjs': fs.readFileSync(root + '/client.mjs', 'utf8'), 'package.json': fs.readFileSync(root + '/package.json', 'utf8')};
if (crypto.createHash('sha256').update(JSON.stringify({version: 1, files})).digest('hex') !== ${JSON.stringify(digest)}) process.exit(1);
`;
  if (sandboxCommandExitCode(await run(`node -e ${quote(verify)} 2>/dev/null`)) === 0) return;
  const editor = session.createEditor?.(runAs);
  if (!editor)
    throw new Error(
      "Managed Codemode client delivery requires sandbox file ingress; update the sandbox provider adapter",
    );
  const stage = `${posix.dirname(directory)}/stage-${randomUUID()}.json`;
  let installationFailure: { error: unknown } | undefined;
  try {
    await editor.createFile({
      type: "create_file",
      path: stage,
      diff: `+${JSON.stringify(client)}`,
    });
    const install = `
const fs = require('node:fs'), crypto = require('node:crypto');
const raw = fs.readFileSync(${JSON.stringify(stage)}, 'utf8').trim();
if (crypto.createHash('sha256').update(raw).digest('hex') !== ${JSON.stringify(digest)}) throw Error('Codemode client transfer integrity failure');
const data = JSON.parse(raw), root = ${JSON.stringify(directory)};
fs.mkdirSync(root, {recursive: true});
if (!fs.lstatSync(root).isDirectory()) throw Error('Codemode client directory must not be a symlink');
for (const name of ['package.json', 'ogtool', 'client.mjs']) {
  const tmp = root + '/' + name + '.' + crypto.randomUUID();
  fs.writeFileSync(tmp, data.files[name], {mode: 0o755, flag: 'wx'});
  fs.renameSync(tmp, root + '/' + name);
}
`;
    const result = await run(`node -e ${quote(install)} && node -e ${quote(verify)}`);
    if (sandboxCommandExitCode(result) !== 0) {
      throw new Error(
        "Managed Codemode client delivery failed; verify Node and sandbox file ingress, then retry with the same worker release",
      );
    }
  } catch (error) {
    installationFailure = { error };
  }
  let cleanupFailure: Error | undefined;
  try {
    await editor.deleteFile({ type: "delete_file", path: stage });
  } catch (editorFailure) {
    // A provider can support ingress but lose its delete reply. Remove only
    // this exact attempt's staging file, through the same command fence.
    try {
      const cleanup = await run(
        `node -e ${quote(`require('node:fs').rmSync(${JSON.stringify(stage)}, {force: true})`)}`,
      );
      if (sandboxCommandExitCode(cleanup) !== 0) {
        throw new Error("Staging file removal failed", { cause: editorFailure });
      }
    } catch (commandFailure) {
      cleanupFailure = new AggregateError(
        [editorFailure, commandFailure],
        "Both cleanup paths failed",
        { cause: commandFailure },
      );
    }
  }
  if (cleanupFailure) {
    throw new AggregateError(
      installationFailure ? [installationFailure.error, cleanupFailure] : [cleanupFailure],
      "Managed Codemode client staging cleanup failed; restore sandbox file ingress/command execution before retrying",
      { cause: installationFailure?.error ?? cleanupFailure },
    );
  }
  if (installationFailure) throw installationFailure.error;
}

export function managedCodemodeClientEnvironment(directory: string): string[] {
  return [
    // A routing proxy can switch to a Connected Machine during the attempt.
    // Its native client is projected by the connection-bound exec transport.
    'if [ -z "${OPENGENI_CODEMODE_NATIVE_CLIENT:-}" ]; then',
    `  export PATH=${quote(directory)}:"$PATH"`,
    `  export OPENGENI_CODEMODE_CLIENT_MODULE=${quote(`${directory}/client.mjs`)}`,
    "else",
    "  unset OPENGENI_CODEMODE_CLIENT_MODULE",
    "fi",
  ];
}
