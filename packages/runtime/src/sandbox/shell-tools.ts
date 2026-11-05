import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { SandboxSessionLike } from "@openai/agents/sandbox";
import { sandboxCommandExitCode, sandboxCommandOutput } from "./command-result";
import {
  MANAGED_SHELL_TOOLS_TARGETS,
  SHELL_TOOLS_NOTICES_FILE,
  SHELL_TOOLS_TARGETS,
  SHELL_TOOLS_VERSIONS,
  type ShellToolName,
} from "./shell-tools-manifest";

/**
 * rg and jq for managed sandboxes, shipped with the worker release beside the
 * managed Codemode client. A box receives them once, during the same setup
 * that installs the client, from a short-lived signed URL or, when the box
 * cannot fetch it (no network, no curl or wget), through the provider's file
 * API. Nothing is downloaded when a command runs.
 *
 * They are appended to the end of PATH, so a system rg or jq always wins, and
 * a box whose image already has both receives nothing. Delivery is best
 * effort: any failure leaves the box as it was and never fails the turn.
 *
 * Connected Machines and compute sandboxes get the same executables from the
 * machine agent instead (`agent/crates/opengeni-agent/src/shell_tools.rs`).
 */

export type ManagedShellToolsArch = keyof typeof MANAGED_SHELL_TOOLS_TARGETS;

export const MANAGED_SHELL_TOOLS_ARCHES = Object.keys(
  MANAGED_SHELL_TOOLS_TARGETS,
) as ManagedShellToolsArch[];

/** One architecture's transfer: a gzip-compressed tar of rg, jq and their notices. */
export type ManagedShellToolsBundle = {
  bytes: Uint8Array;
  /** SHA-256 of `bytes`, also the installed directory's completion marker. */
  sha256: string;
  /** SHA-256 of each executable inside. */
  binarySha256: Record<ShellToolName, string>;
};

export type ManagedShellTools = Record<ManagedShellToolsArch, ManagedShellToolsBundle>;

/** Short-lived signed URLs for the release's bundles, per architecture. */
export type ManagedShellToolsDownload = Partial<Record<ManagedShellToolsArch, string>>;

/**
 * Where a managed box keeps them. The name carries the versions, so every
 * worker computes the same PATH entry without loading the bundles, and a new
 * release with other versions installs beside, never over, the old one.
 */
export const MANAGED_SHELL_TOOLS_DIRECTORY = posix.join(
  "/workspace/.opengeni/shell-tools",
  `rg-${SHELL_TOOLS_VERSIONS.rg.version}-jq-${SHELL_TOOLS_VERSIONS.jq.version}`,
);

export const MANAGED_SHELL_TOOLS_ASSET_DIRECTORY = "shell-tools";

export function managedShellToolsAssetName(arch: ManagedShellToolsArch): string {
  return `linux-${arch}.tar.gz`;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The per-command PATH line: append the directory once, after everything the
 * box already has. A missing directory costs nothing; the shell skips it.
 */
export function managedShellToolsPathEnvironment(
  directory = MANAGED_SHELL_TOOLS_DIRECTORY,
): string {
  return `case ":$PATH:" in *:${quote(directory)}:*) ;; *) export PATH="$PATH":${quote(directory)} ;; esac`;
}

// ---- Bundle format ---------------------------------------------------------

function tarHeader(name: string, size: number, mode: number): Uint8Array {
  const header = new Uint8Array(512);
  const put = (offset: number, length: number, value: string) => {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > length) throw new Error(`tar field too long: ${name}`);
    header.set(bytes, offset);
  };
  const octal = (value: number, length: number) =>
    value.toString(8).padStart(length - 1, "0") + "\0";
  put(0, 100, name);
  put(100, 8, octal(mode, 8));
  put(108, 8, octal(0, 8));
  put(116, 8, octal(0, 8));
  put(124, 12, octal(size, 12));
  put(136, 12, octal(0, 12));
  put(148, 8, "        ");
  put(156, 1, "0");
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  put(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** A deterministic `.tar.gz` holding exactly `rg`, `jq` and the notices. */
export function buildManagedShellToolsBundle(files: {
  rg: Uint8Array;
  jq: Uint8Array;
  notices: Uint8Array;
}): ManagedShellToolsBundle {
  const parts: Uint8Array[] = [];
  for (const [name, bytes, mode] of [
    ["rg", files.rg, 0o755],
    ["jq", files.jq, 0o755],
    [SHELL_TOOLS_NOTICES_FILE, files.notices, 0o644],
  ] as const) {
    parts.push(tarHeader(name, bytes.byteLength, mode), bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding) parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(1024));
  const tar = Buffer.concat(parts);
  const bytes = new Uint8Array(gzipSync(tar, { level: 9 }));
  return {
    bytes,
    sha256: sha256(bytes),
    binarySha256: { rg: sha256(files.rg), jq: sha256(files.jq) },
  };
}

// ---- Loading the release's bundles ------------------------------------------

/** Notices text kept beside this module in the source tree. */
export function shellToolsNotices(): Uint8Array {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "shell-tools-THIRD-PARTY-NOTICES.txt"),
  );
}

/**
 * Bundles from a `scripts/fetch-shell-tools.ts` output directory, each
 * executable checked against the manifest.
 */
export function managedShellToolsFromDirectory(directory: string): ManagedShellTools {
  const notices = readFileSync(join(directory, SHELL_TOOLS_NOTICES_FILE));
  const read = (arch: ManagedShellToolsArch, tool: ShellToolName) => {
    const target = MANAGED_SHELL_TOOLS_TARGETS[arch];
    const bytes = readFileSync(join(directory, target, tool));
    if (sha256(bytes) !== SHELL_TOOLS_TARGETS[target][tool].binarySha256) {
      throw new Error(`Shell tool ${tool} for ${target} does not match the pinned checksum`);
    }
    return bytes;
  };
  return Object.fromEntries(
    MANAGED_SHELL_TOOLS_ARCHES.map((arch) => [
      arch,
      buildManagedShellToolsBundle({ rg: read(arch, "rg"), jq: read(arch, "jq"), notices }),
    ]),
  ) as ManagedShellTools;
}

let releaseTools: Promise<ManagedShellTools | null> | undefined;

/**
 * The bundles this worker release carries, or null when it carries none (a
 * source checkout without `OPENGENI_SHELL_TOOLS_DIR`, or a published runtime
 * package). Without them boxes simply keep the tools their image has.
 */
export function loadManagedShellTools(): Promise<ManagedShellTools | null> {
  return (releaseTools ??= (async () => {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    for (const root of [
      join(moduleDir, "assets"),
      join(moduleDir, "../assets"),
      join(moduleDir, "../../dist/assets"),
    ]) {
      const directory = join(root, MANAGED_SHELL_TOOLS_ASSET_DIRECTORY);
      if (!existsSync(join(directory, managedShellToolsAssetName("x86_64")))) continue;
      return Object.fromEntries(
        MANAGED_SHELL_TOOLS_ARCHES.map((arch) => {
          const bytes = new Uint8Array(
            readFileSync(join(directory, managedShellToolsAssetName(arch))),
          );
          const target = SHELL_TOOLS_TARGETS[MANAGED_SHELL_TOOLS_TARGETS[arch]];
          return [
            arch,
            {
              bytes,
              sha256: sha256(bytes),
              binarySha256: { rg: target.rg.binarySha256, jq: target.jq.binarySha256 },
            },
          ];
        }),
      ) as ManagedShellTools;
    }
    const fetched = process.env.OPENGENI_SHELL_TOOLS_DIR;
    if (fetched) return managedShellToolsFromDirectory(fetched);
    return null;
  })());
}

export function resetManagedShellToolsForTest(): void {
  releaseTools = undefined;
}

// ---- Installing in a box ----------------------------------------------------

const MARKER = ".complete";
const RESULT_PREFIX = "opengeni-shell-tools:";

export type ManagedShellToolsInstallResult =
  | "present"
  | "system"
  | "installed"
  | "unsupported"
  | "failed";

function archSelection(tools: ManagedShellTools, download?: ManagedShellToolsDownload): string {
  const branch = (arch: ManagedShellToolsArch) => {
    return [
      `want=${quote(tools[arch].sha256)}`,
      `rg_sum=${quote(tools[arch].binarySha256.rg)}`,
      `jq_sum=${quote(tools[arch].binarySha256.jq)}`,
      `url=${quote(download?.[arch] ?? "")}`,
    ].join("; ");
  };
  return [
    'case "$(uname -m 2>/dev/null)" in',
    `  x86_64|amd64) arch=x86_64; ${branch("x86_64")} ;;`,
    `  aarch64|arm64) arch=aarch64; ${branch("aarch64")} ;;`,
    `  *) echo '${RESULT_PREFIX} unsupported'; exit 0 ;;`,
    "esac",
  ].join("\n");
}

/**
 * Shared POSIX shell for both delivery paths. It needs only tar (with gzip),
 * and checks every checksum with sha256sum, shasum or openssl when the box has
 * one; gzip's own CRC still guards a box with none. Files move into place one
 * rename at a time and the marker comes last, so a concurrent install or an
 * interrupted one never leaves a directory that claims to be complete.
 */
function installFunctions(): string {
  return [
    "sum() {",
    '  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d " " -f 1',
    '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d " " -f 1',
    '  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed "s/.* //"',
    "  fi",
    "}",
    "matches() {",
    '  got="$(sum "$1" 2>/dev/null)"',
    '  [ -z "$got" ] || [ "$got" = "$2" ]',
    "}",
    "install_bundle() {",
    '  matches "$1" "$want" || return 1',
    '  mkdir -p "$dir" || return 1',
    '  stage="$dir/.stage.$$"',
    '  rm -rf "$stage"; mkdir "$stage" || return 1',
    '  if ! tar -xzf "$1" -C "$stage" 2>/dev/null && ! (gzip -dc < "$1" | tar -xf - -C "$stage") 2>/dev/null; then rm -rf "$stage"; return 1; fi',
    '  if ! matches "$stage/rg" "$rg_sum" || ! matches "$stage/jq" "$jq_sum"; then rm -rf "$stage"; return 1; fi',
    '  chmod 0755 "$stage/rg" "$stage/jq" || { rm -rf "$stage"; return 1; }',
    '  if ! "$stage/rg" --version >/dev/null 2>&1 || ! "$stage/jq" --version >/dev/null 2>&1; then rm -rf "$stage"; return 1; fi',
    `  for name in ${SHELL_TOOLS_NOTICES_FILE} rg jq; do mv -f "$stage/$name" "$dir/$name" || { rm -rf "$stage"; return 1; }; done`,
    `  printf '%s\\n' "$want" > "$stage/${MARKER}" && mv -f "$stage/${MARKER}" "$dir/${MARKER}"`,
    "  status=$?",
    '  rm -rf "$stage"',
    "  return $status",
    "}",
  ].join("\n");
}

function preamble(
  tools: ManagedShellTools,
  directory: string,
  download?: ManagedShellToolsDownload,
): string {
  return [
    `dir=${quote(directory)}`,
    archSelection(tools, download),
    `if [ "$(cat "$dir/${MARKER}" 2>/dev/null)" = "$want" ]; then echo '${RESULT_PREFIX} present'; exit 0; fi`,
    installFunctions(),
  ].join("\n");
}

/**
 * The first setup command: report what the box already has, otherwise fetch
 * this architecture's bundle and install it. It prints `need <arch>` when the
 * bytes must be staged through the file API instead.
 */
export function managedShellToolsProbeCommand(
  tools: ManagedShellTools,
  download?: ManagedShellToolsDownload,
  directory = MANAGED_SHELL_TOOLS_DIRECTORY,
): string {
  return [
    "(",
    preamble(tools, directory, download),
    `if command -v rg >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then echo '${RESULT_PREFIX} system'; exit 0; fi`,
    'if [ -n "$url" ]; then',
    '  fetched="$(mktemp "${TMPDIR:-/tmp}/opengeni-shell-tools.XXXXXX")" || fetched=""',
    '  if [ -n "$fetched" ]; then',
    "    trap 'rm -f -- \"$fetched\"' EXIT",
    '    if command -v curl >/dev/null 2>&1; then curl --fail --location --silent --show-error --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 1 --output "$fetched" "$url" >/dev/null 2>&1',
    '    elif command -v wget >/dev/null 2>&1; then wget -q -T 60 -O "$fetched" "$url" >/dev/null 2>&1',
    "    else false",
    `    fi && install_bundle "$fetched" && { echo '${RESULT_PREFIX} installed'; exit 0; }`,
    "  fi",
    "fi",
    // The file API stages beside this directory, so it must exist first.
    'mkdir -p "$dir" 2>/dev/null',
    `echo "${RESULT_PREFIX} need $arch"`,
    ")",
  ].join("\n");
}

/** The fallback command: install from base64 text staged through the file API. */
export function managedShellToolsStagedInstallCommand(
  tools: ManagedShellTools,
  arch: ManagedShellToolsArch,
  stagedFile: string,
  directory = MANAGED_SHELL_TOOLS_DIRECTORY,
): string {
  return [
    "(",
    preamble(tools, directory),
    `[ "$arch" = ${quote(arch)} ] || exit 1`,
    'decoded="$(mktemp "${TMPDIR:-/tmp}/opengeni-shell-tools.XXXXXX")" || exit 1',
    "trap 'rm -f -- \"$decoded\"' EXIT",
    `staged=${quote(stagedFile)}`,
    'if base64 -d < "$staged" > "$decoded" 2>/dev/null || openssl base64 -d -A -in "$staged" -out "$decoded" 2>/dev/null; then',
    `  install_bundle "$decoded" && { echo '${RESULT_PREFIX} installed'; exit 0; }`,
    "fi",
    "exit 1",
    ")",
  ].join("\n");
}

function parseResult(output: string): ManagedShellToolsInstallResult | `need ${string}` | null {
  for (const line of output.split("\n").reverse()) {
    const index = line.indexOf(RESULT_PREFIX);
    if (index >= 0) {
      const value = line.slice(index + RESULT_PREFIX.length).trim();
      if (
        value === "present" ||
        value === "system" ||
        value === "installed" ||
        value === "unsupported" ||
        value.startsWith("need ")
      ) {
        return value as ManagedShellToolsInstallResult | `need ${string}`;
      }
    }
  }
  return null;
}

/**
 * Give one box this release's rg and jq unless it already has them. A command
 * that runs but cannot deliver them returns "failed" and the box keeps what it
 * had. Provider errors (from `run` or the file API) propagate unchanged; the
 * setup hook treats each one except a turn cancellation as a failed delivery,
 * so a Steer or Pause still stops setup.
 */
export async function installManagedShellTools(
  session: SandboxSessionLike,
  tools: ManagedShellTools,
  run: (cmd: string) => Promise<unknown>,
  runAs?: string,
  download?: ManagedShellToolsDownload,
  directory = MANAGED_SHELL_TOOLS_DIRECTORY,
): Promise<ManagedShellToolsInstallResult> {
  const probe = await run(managedShellToolsProbeCommand(tools, download, directory));
  const outcome = parseResult(sandboxCommandOutput(probe));
  if (outcome === null) return "failed";
  if (!outcome.startsWith("need ")) return outcome as ManagedShellToolsInstallResult;
  const arch = outcome.slice("need ".length) as ManagedShellToolsArch;
  if (!MANAGED_SHELL_TOOLS_ARCHES.includes(arch)) return "failed";
  const editor = session.createEditor?.(runAs);
  if (!editor) return "failed";
  const stage = `${posix.dirname(directory)}/stage-${randomUUID()}.b64`;
  let result: ManagedShellToolsInstallResult = "failed";
  try {
    await editor.createFile({
      type: "create_file",
      path: stage,
      diff: `+${Buffer.from(tools[arch].bytes).toString("base64")}`,
    });
    const installed = await run(
      managedShellToolsStagedInstallCommand(tools, arch, stage, directory),
    );
    if (
      sandboxCommandExitCode(installed) === 0 &&
      parseResult(sandboxCommandOutput(installed)) === "installed"
    ) {
      result = "installed";
    }
  } finally {
    try {
      await editor.deleteFile({ type: "delete_file", path: stage });
    } catch {
      // Release bytes only; a leftover staging file cannot affect commands.
    }
  }
  return result;
}
