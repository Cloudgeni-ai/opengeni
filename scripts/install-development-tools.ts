/** Opt-in native developer tools only; never installs artifact runtimes or OS packages. */
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import garageProvenance from "./install-development-tools.garage-provenance.json";

export type Target = { os: "linux" | "darwin"; arch: "amd64" | "arm64"; wsl2: boolean };
export type ToolName = "nats" | "temporal" | "garage";
export type Asset = { tool: ToolName; version: string; url: string; sha256: string; member: string; binary: string; checksumSource: string; format: "tar.gz" | "binary" };
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const MAX_EXPANDED = 250 * 1024 * 1024;

// Pinned from the official release checksum files, not hashes derived from downloads.
const hashes = {
  nats: {
    "linux-amd64": "397a6deffb5533e160de0cca322bc3dcaec7fb7282d66a3dfa87a9c183152ad1",
    "linux-arm64": "b08936cb1dc0ae7086137bda14c352df64397c4af45ed2b392705c19585aeb84",
    "darwin-amd64": "002c943c1ed39c55cc5e024debfc02685111fcb2b1cbd887aad39ac977037477",
    "darwin-arm64": "23e0c5354c2da385708946a21900c944fcb9a3bbfd02aae27a4ae750dea0b682",
  },
  temporal: {
    "linux-amd64": "e2063feade24d90cec1590dd9a46b0ccf838433b013738a348af1c01a9cb3874",
    "linux-arm64": "3309f004380edc51ad833937bfd16fe3f2b93aa80f8b46b788de4e371f7628f2",
    "darwin-amd64": "99e9188952b3cbd4775c0012c210d3f42d5035cd39ca49676ae18c15e9107d3c",
    "darwin-arm64": "cccbead89534e365a3527d40f6d3370a8fa16af6d7853c9864422fb1f7053fe4",
  },
} as const;

export function detectTarget(os = platform(), cpu = arch(), kernel = release()): Target {
  if (os === "win32") throw new Error("Native Windows is unsupported: the full launcher requires Bash. Install WSL2, clone into its Linux filesystem, and run Bun and this script inside WSL2 (not PowerShell/Git Bash).");
  if (os !== "linux" && os !== "darwin") throw new Error(`Unsupported OS: ${os}`);
  if (cpu !== "x64" && cpu !== "arm64") throw new Error(`Unsupported architecture: ${cpu}; supported: x64, arm64.`);
  const microsoft = /microsoft/i.test(kernel);
  if (os === "linux" && microsoft && !/wsl2|microsoft-standard/i.test(kernel)) throw new Error("WSL1 is unsupported; convert the distribution to WSL2 and run inside Linux.");
  return { os, arch: cpu === "x64" ? "amd64" : "arm64", wsl2: os === "linux" && microsoft };
}

export function garageDiagnostic(target: Target): string {
  return target.os === "darwin"
    ? "Garage 2.3.0 has no official macOS binary. Use the repository Docker infrastructure, or manually build the tagged source with upstream-supported prerequisites; source-build compatibility is not guaranteed by this installer. Rust is never auto-installed."
    : "Garage 2.3.0 Linux binaries are verified against repository SHA-256 pins derived from the existing digest-pinned official Docker image (not an upstream native checksum manifest). No Docker daemon or source compiler is needed. See install-development-tools.garage-provenance.json and its opt-in verification test.";
}

export function assetFor(tool: ToolName, target: Target): Asset {
  if (tool === "garage") {
    if (target.os !== "linux") throw new Error(garageDiagnostic(target));
    const provenance = garageProvenance.targets[target.arch];
    return { tool, version: "2.3.0", url: provenance.nativeUrl, sha256: provenance.binarySha256, member: "garage", binary: "garage", checksumSource: garageProvenance.image, format: "binary" };
  }
  const key = `${target.os}-${target.arch}` as const;
  if (tool === "nats") {
    const base = "https://github.com/nats-io/nats-server/releases/download/v2.11.8";
    const stem = `nats-server-v2.11.8-${key}`;
    return { tool, version: "2.11.8", url: `${base}/${stem}.tar.gz`, sha256: hashes.nats[key], member: `${stem}/nats-server`, binary: "nats-server", checksumSource: `${base}/SHA256SUMS`, format: "tar.gz" };
  }
  const base = "https://github.com/temporalio/cli/releases/download/v1.4.1";
  return { tool, version: "1.4.1", url: `${base}/temporal_cli_1.4.1_${target.os}_${target.arch}.tar.gz`, sha256: hashes.temporal[key], member: "temporal", binary: "temporal", checksumSource: `${base}/checksums.txt`, format: "tar.gz" };
}

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Never extract paths to disk. Accept only bounded, ordinary ustar files/directories. */
export function extractBinary(archive: Uint8Array, asset: Asset): Buffer {
  if (sha256(archive) !== asset.sha256) throw new Error(`${asset.tool}: SHA-256 mismatch; nothing installed.`);
  if (asset.format === "binary") return Buffer.from(archive);
  const tar = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED });
  let result: Buffer | undefined;
  let ended = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) { ended = true; break; }
    const field = (start: number, end: number) => header.subarray(start, end).toString("utf8").split("\0")[0]!;
    const octal = (text: string) => {
      if (!/^[0-7]+$/.test(text.trim())) throw new Error("Invalid tar numeric field");
      return Number.parseInt(text.trim(), 8);
    };
    const checksum = octal(field(148, 156));
    const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (actual !== checksum) throw new Error("Invalid tar header checksum");
    const prefix = field(345, 500);
    const name = `${prefix ? `${prefix}/` : ""}${field(0, 100)}`;
    const parts = name.replace(/\/$/, "").split("/");
    if (name.startsWith("/") || name.includes("\\") || parts.some((p) => !p || p === "." || p === "..") || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Unsafe tar path");
    const type = field(156, 157);
    if (type !== "" && type !== "0" && type !== "5") throw new Error("Unsupported tar entry (links and extensions forbidden)");
    const size = octal(field(124, 136));
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length || (type === "5" && size !== 0)) throw new Error("Invalid tar entry size");
    if (name === asset.member) {
      if (result || type === "5" || size === 0) throw new Error("Invalid or duplicate binary entry");
      result = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!ended || !result) throw new Error(`Missing binary or tar terminator: ${asset.member}`);
  return result;
}

export async function downloadAsset(
  url: string,
  request: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  const allowed = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "garagehq.deuxfleurs.fr"]);
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !allowed.has(parsed.hostname) || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) throw new Error("Untrusted download URL");
      const response = await request(url, { redirect: "manual", signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect missing location");
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Download failed: HTTP ${response.status}`); }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_DOWNLOAD) throw new Error("Download exceeds 100 MiB bound");
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      return Buffer.concat(chunks);
    }
    throw new Error("Too many download redirects");
  } finally { clearTimeout(timer); }
}

async function ensureDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing non-directory/symlink: ${path}`);
}

export function toolBin(root: string, target: Target): string {
  return join(root, ".opengeni", "development-tools", `${target.os}-${target.arch}`, "nats-2.11.8_temporal-1.4.1", "bin");
}

/** Existing tools are compared, never replaced. link() atomically refuses collisions. */
export async function installBinary(root: string, target: Target, asset: Asset, binary: Uint8Array): Promise<string> {
  root = await realpath(root);
  let directory = root;
  for (const part of [".opengeni", "development-tools", `${target.os}-${target.arch}`, "nats-2.11.8_temporal-1.4.1", "bin"]) {
    directory = join(directory, part);
    await ensureDirectory(directory);
  }
  if (!["nats-server", "temporal", "garage"].includes(asset.binary)) throw new Error("Unsupported binary destination");
  const destination = join(directory, asset.binary);
  try {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink() || !(existing.mode & 0o111) || sha256(await readFile(destination)) !== sha256(binary)) throw new Error(`Existing tool differs; preserving ${destination}. Move it manually before retrying.`);
    return destination;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const staging = await mkdtemp(join(directory, ".bootstrap-"));
  try {
    const temporary = join(staging, "binary");
    await writeFile(temporary, binary, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o755);
    await link(temporary, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return destination;
}

export function parseArgs(args: string[]) {
  let install = false;
  let json = false;
  let tools: ToolName[] = ["garage", "nats", "temporal"];
  for (const arg of args) {
    if (arg === "--install") install = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--tools=")) {
      const names = arg.slice(8).split(",");
      if (!names.length || names.some((name) => !["garage", "nats", "temporal"].includes(name)) || new Set(names).size !== names.length) throw new Error("--tools accepts unique comma-separated garage,nats,temporal names");
      tools = names as ToolName[];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { install, json, tools };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const target = detectTarget();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const assets = options.tools.filter((name) => name !== "garage" || target.os === "linux").map((name) => assetFor(name, target));
  const blockers = options.tools.includes("garage") && target.os !== "linux" ? [garageDiagnostic(target)] : [];
  const manualPreconditions = [
    "Use the repository-pinned Bun version, Git and Bash; Windows users must run the entire launcher inside WSL2.",
    "Provision PostgreSQL 16+ server/client and contrib (pgcrypto) using your OS package manager; ensure initdb, pg_ctl, psql and createdb are on PATH. Match extensions to the server major; this script never sudo-installs packages or changes database data.",
    target.os === "darwin" ? "Install Xcode Command Line Tools manually (xcode-select --install); configure PostgreSQL using your chosen package manager." : "Debian/Ubuntu guidance: install build-essential, pkg-config, libssl-dev, PostgreSQL server/client/contrib through your administrator; other distributions use equivalent packages.",
    "If a selected build needs Rust, install rustup yourself and honor repository rust-toolchain.toml; no automatic Rust installation.",
    garageDiagnostic(target),
    "Artifact runtimes are provisioned separately; installing these tools does not mean the full development stack is ready.",
  ];
  const installed: string[] = [];
  if (options.install && !blockers.length) {
    // Verify every selected archive before writing any tool.
    const binaries: { asset: Asset; binary: Buffer }[] = [];
    for (const asset of assets) binaries.push({ asset, binary: extractBinary(await downloadAsset(asset.url), asset) });
    for (const { asset, binary } of binaries) installed.push(await installBinary(root, target, asset, binary));
  }
  const result = { schemaVersion: 1, status: blockers.length ? "blocked" : options.install ? "installed" : "plan", target, binDirectory: toolBin(root, target), assets, installed, blockers, manualPreconditions };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Development tools: ${result.status}\nPATH directory: ${result.binDirectory}`);
    for (const asset of assets) console.log(`${asset.tool} ${asset.version}: ${asset.url}`);
    for (const message of manualPreconditions) console.log(`Manual prerequisite: ${message}`);
    console.log("Explicit supported subset: bun scripts/install-development-tools.ts --install --tools=nats,temporal --json");
  }
  if (options.install && blockers.length) process.exitCode = 1;
  return result;
}

if (import.meta.main) main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ schemaVersion: 1, status: "error", error: message }));
  else console.error(message);
  process.exitCode = 1;
});