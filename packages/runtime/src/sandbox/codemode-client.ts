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

/** The exact transfer bytes: their SHA-256 is the client digest. */
export function managedCodemodeClientBytes(client: ManagedCodemodeClient): string {
  return JSON.stringify(client);
}

/**
 * A short-lived signed URL for this release's client bytes, published by the
 * worker under the client digest. The box fetches the bytes itself, so a fresh
 * box installs the client in one provider command instead of staging a large
 * file through several editor round trips.
 */
export type ManagedCodemodeClientDownload = { url: string };

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
  download?: ManagedCodemodeClientDownload,
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
  // The staged transfer file is the first argument, so the same program
  // installs from a fetched file and from an editor-staged one.
  const install = `
const fs = require('node:fs'), crypto = require('node:crypto');
const raw = fs.readFileSync(process.argv[1], 'utf8').trim();
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
  if (download) {
    // One command whether the box is warm or fresh: verify, otherwise fetch the
    // digest-addressed bytes, install, and verify. Any failure (storage,
    // network, a missing curl) falls back to editor staging below.
    // A subshell scopes `exit` and the cleanup trap to this program.
    const fetchInstall = [
      "(",
      `if node -e ${quote(verify)} 2>/dev/null; then exit 0; fi`,
      'stage="$(mktemp "${TMPDIR:-/tmp}/opengeni-codemode-client.XXXXXX")" || exit 1',
      "trap 'rm -f -- \"$stage\"' EXIT",
      `curl --fail --location --silent --show-error --connect-timeout 10 --max-time 60 --retry 2 --retry-delay 1 --output "$stage" ${quote(download.url)} || exit 1`,
      `node -e ${quote(install)} "$stage" && node -e ${quote(verify)}`,
      ")",
    ].join("\n");
    try {
      if (sandboxCommandExitCode(await run(fetchInstall)) === 0) return;
    } catch {
      // Fall through to the editor path, which reports its own failure.
    }
    // Bounded diagnostic only: never the signed URL or command output.
    console.warn("Managed Codemode client download failed; staging the release bytes instead", {
      digest,
    });
  } else if (sandboxCommandExitCode(await run(`node -e ${quote(verify)} 2>/dev/null`)) === 0) {
    return;
  }
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
      diff: `+${managedCodemodeClientBytes(client)}`,
    });
    const result = await run(
      `node -e ${quote(install)} ${quote(stage)} && node -e ${quote(verify)}`,
    );
    if (sandboxCommandExitCode(result) !== 0) {
      throw new Error(
        "Managed Codemode client delivery failed; verify Node and sandbox file ingress, then retry with the same worker release",
      );
    }
  } catch (error) {
    installationFailure = { error };
  }
  try {
    await editor.deleteFile({ type: "delete_file", path: stage });
  } catch {
    // A provider can support ingress but lose its delete reply. Remove only
    // this exact attempt's staging file, through the same command fence.
    try {
      const cleanup = await run(
        `node -e ${quote(`require('node:fs').rmSync(${JSON.stringify(stage)}, {force: true})`)}`,
      );
      if (sandboxCommandExitCode(cleanup) !== 0) {
        throw new Error("Staging file removal failed");
      }
    } catch {
      // This file contains only immutable, non-secret release bytes. Failed
      // housekeeping cannot invalidate a verified install or wrap its original
      // delivery error (especially pre-dispatch/outcome-unknown provenance).
      // Log one bounded identity, never provider errors, output, or client bytes.
      try {
        console.warn(
          "Managed Codemode client staging cleanup failed; installation result preserved",
          {
            stageFile: posix.basename(stage),
            installation: installationFailure ? "failed" : "verified",
          },
        );
      } catch {
        // Diagnostics must not change the installation result either.
      }
    }
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
