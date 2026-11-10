/**
 * Fetches the pinned ripgrep and jq builds and writes, for each requested
 * target, `<out>/<target>/rg[.exe]` and `jq[.exe]` plus one
 * `<out>/THIRD-PARTY-NOTICES.txt`. Every download, every extracted executable
 * and every executable committed to the repository (the Linux jq) is checked
 * against `packages/runtime/src/sandbox/shell-tools-manifest.ts`.
 *
 *   bun scripts/fetch-shell-tools.ts --out <dir> (--all | --target <target>...) [--offline]
 *
 * Downloads are cached by checksum in `OPENGENI_SHELL_TOOLS_CACHE` (default
 * `~/.cache/opengeni/shell-tools`). `--offline` uses the cache only, for image
 * builds that place the assets there with `ADD --checksum`.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import {
  SHELL_TOOLS_NOTICES_FILE,
  SHELL_TOOLS_TARGETS,
  shellToolFileName,
  type ShellToolDownload,
  type ShellToolName,
  type ShellToolsTarget,
  type ShellToolVendored,
} from "../packages/runtime/src/sandbox/shell-tools-manifest";

const REPOSITORY = resolve(import.meta.dir, "..");
const NOTICES = join(
  REPOSITORY,
  "packages/runtime/src/sandbox/shell-tools-THIRD-PARTY-NOTICES.txt",
);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The member `name` of an uncompressed ustar/GNU tar archive. */
export function tarMember(tar: Uint8Array, name: string): Uint8Array | null {
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return null;
    const field = (start: number, length: number) =>
      decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const member = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const body = offset + 512;
    if (member === name && (type === "0" || type === "")) {
      return tar.subarray(body, body + size);
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** The member `name` of a zip archive, stored or deflated. */
export function zipMember(zip: Uint8Array, name: string): Uint8Array | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("zip: no end of central directory");
  const count = view.getUint16(end + 10, true);
  let entry = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (view.getUint32(entry, true) !== 0x02014b50) throw new Error("zip: bad central entry");
    const method = view.getUint16(entry + 10, true);
    const compressedSize = view.getUint32(entry + 20, true);
    const nameLength = view.getUint16(entry + 28, true);
    const extraLength = view.getUint16(entry + 30, true);
    const commentLength = view.getUint16(entry + 32, true);
    const local = view.getUint32(entry + 42, true);
    const member = decoder.decode(zip.subarray(entry + 46, entry + 46 + nameLength));
    if (member === name) {
      const dataStart =
        local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return new Uint8Array(inflateRawSync(data));
      throw new Error(`zip: unsupported compression method ${method}`);
    }
    entry += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** The executable inside a downloaded asset, checked against its pin. */
export function extractShellTool(asset: ShellToolDownload, bytes: Uint8Array): Uint8Array {
  if (sha256(bytes) !== asset.sha256) {
    throw new Error(`${asset.url} does not match its pinned SHA-256`);
  }
  let executable: Uint8Array | null = bytes;
  if (asset.member) {
    executable = asset.url.endsWith(".zip")
      ? zipMember(bytes, asset.member)
      : tarMember(new Uint8Array(gunzipSync(bytes)), asset.member);
  }
  if (!executable) throw new Error(`${asset.url} has no ${asset.member}`);
  if (sha256(executable) !== asset.binarySha256) {
    throw new Error(`${asset.member ?? asset.url} does not match its pinned SHA-256`);
  }
  return executable;
}

function cacheDirectory(): string {
  return process.env.OPENGENI_SHELL_TOOLS_CACHE || join(homedir(), ".cache/opengeni/shell-tools");
}

/** A committed executable, checked against its pin. Never downloaded. */
export async function vendoredShellTool(
  asset: ShellToolVendored,
  repository = REPOSITORY,
): Promise<Uint8Array> {
  const executable = new Uint8Array(await readFile(join(repository, asset.path)));
  if (sha256(executable) !== asset.binarySha256) {
    throw new Error(`${asset.path} does not match its pinned SHA-256`);
  }
  return executable;
}

async function assetBytes(asset: ShellToolDownload, offline: boolean): Promise<Uint8Array> {
  const cached = join(cacheDirectory(), asset.sha256);
  if (existsSync(cached)) {
    const bytes = new Uint8Array(await readFile(cached));
    if (sha256(bytes) === asset.sha256) return bytes;
  }
  if (offline) throw new Error(`${asset.url} is not in the cache (${cached}) and --offline is set`);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(asset.url, {
        redirect: "follow",
        // A stalled download must not hang an image or agent build.
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${asset.url}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (sha256(bytes) !== asset.sha256) {
        throw new Error(`${asset.url} does not match its pinned SHA-256`);
      }
      await mkdir(dirname(cached), { recursive: true });
      const temporary = `${cached}.${process.pid}`;
      await writeFile(temporary, bytes);
      await rename(temporary, cached);
      return bytes;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function fetchShellTools(input: {
  out: string;
  targets: readonly ShellToolsTarget[];
  offline?: boolean;
}): Promise<void> {
  for (const target of input.targets) {
    const directory = join(input.out, target);
    await mkdir(directory, { recursive: true });
    for (const tool of ["rg", "jq"] as const satisfies readonly ShellToolName[]) {
      const asset = SHELL_TOOLS_TARGETS[target][tool];
      const executable =
        "path" in asset
          ? await vendoredShellTool(asset)
          : extractShellTool(asset, await assetBytes(asset, input.offline === true));
      const path = join(directory, shellToolFileName(target, tool));
      await writeFile(path, executable);
      await chmod(path, 0o755);
    }
  }
  await mkdir(input.out, { recursive: true });
  await copyFile(NOTICES, join(input.out, SHELL_TOOLS_NOTICES_FILE));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let out: string | undefined;
  let offline = false;
  const targets: ShellToolsTarget[] = [];
  const known = Object.keys(SHELL_TOOLS_TARGETS) as ShellToolsTarget[];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--out") out = args[++index];
    else if (arg === "--offline") offline = true;
    else if (arg === "--all") targets.push(...known);
    else if (arg === "--target") {
      const target = args[++index] as ShellToolsTarget;
      if (!known.includes(target)) throw new Error(`Unknown shell tools target: ${target}`);
      targets.push(target);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out || targets.length === 0) {
    throw new Error(
      "Usage: bun scripts/fetch-shell-tools.ts --out <dir> (--all | --target <target>...) [--offline]",
    );
  }
  await fetchShellTools({ out: resolve(out), targets: [...new Set(targets)], offline });
  console.log(`Shell tools written to ${resolve(out)}`);
}
