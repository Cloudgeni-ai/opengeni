import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const ARTIFACT_TARGETS = new Map([
  ["opengeni-agent-x86_64-unknown-linux-musl", "x86_64-unknown-linux-musl"],
  ["opengeni-agent-aarch64-unknown-linux-musl", "aarch64-unknown-linux-musl"],
  ["opengeni-agent-universal-apple-darwin", "universal-apple-darwin"],
  ["opengeni-agent-x86_64-pc-windows-msvc.exe", "x86_64-pc-windows-msvc"],
  ["opengeni-agent-aarch64-pc-windows-msvc.exe", "aarch64-pc-windows-msvc"],
] as const);

export type AgentManifestArtifact = {
  target: string;
  url: string;
  size: number;
  sha256: string;
  minisig_url: string;
};

export type AgentUpdateManifest = {
  channel: "stable";
  version: string;
  min_supported: string;
  rollout_percent: number;
  cohort_salt: string;
  artifacts: AgentManifestArtifact[];
  notes_url: string;
  signed_at_ms: number;
  force: boolean;
};

export type GenerateAgentManifestOptions = {
  dir: string;
  version: string;
  releaseDownloadBase: string;
  signedAtMs: number;
  minSupported?: string;
  rolloutPercent?: number;
  cohortSalt?: string;
  notesUrl?: string;
};

function isVersion(value: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function normalizedReleaseBase(value: string): string {
  const base = value.replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+(?:\/.*)?$/.test(base)) {
    throw new Error("releaseDownloadBase must be an absolute HTTPS URL");
  }
  return base;
}

async function sidecarHash(path: string, asset: string): Promise<string> {
  const line = (await readFile(path, "utf8")).trim().split(/\r?\n/, 1)[0] ?? "";
  const [hash, namedAsset] = line.trim().split(/\s+/, 2);
  if (!hash || !/^[a-f0-9]{64}$/.test(hash) || (namedAsset && basename(namedAsset) !== asset)) {
    throw new Error(`invalid sha256 sidecar for ${asset}`);
  }
  return hash;
}

/**
 * Build the stable manifest only from completed, signed release artifacts.
 * The returned object is deliberately JSON-ready and has no signing-key input:
 * signing happens in CI after this deterministic validation step.
 */
export async function generateAgentUpdateManifest(
  options: GenerateAgentManifestOptions,
): Promise<AgentUpdateManifest> {
  if (!isVersion(options.version)) {
    throw new Error("version must be a concrete semantic version without a v prefix");
  }
  if (options.minSupported !== undefined && !isVersion(options.minSupported)) {
    throw new Error("minSupported must be a concrete semantic version without a v prefix");
  }
  if (!Number.isSafeInteger(options.signedAtMs) || options.signedAtMs < 0) {
    throw new Error("signedAtMs must be a non-negative integer");
  }
  const rolloutPercent = options.rolloutPercent ?? 100;
  if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
    throw new Error("rolloutPercent must be an integer from 0 through 100");
  }
  const base = normalizedReleaseBase(options.releaseDownloadBase);
  const tag = `agent-v${options.version}`;
  const artifacts = await Promise.all(
    [...ARTIFACT_TARGETS.entries()].map(async ([asset, target]) => {
      const path = join(options.dir, asset);
      const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
      if (!info.isFile() || info.size <= 0) {
        throw new Error(`artifact is not a non-empty regular file: ${asset}`);
      }
      // An artifact without this detached signature is never eligible for stable.
      const signature = await stat(`${path}.minisig`).catch(() => null);
      if (!signature?.isFile() || signature.size <= 0) {
        throw new Error(`missing detached minisign signature for ${asset}`);
      }
      const sha256 = await sidecarHash(`${path}.sha256`, asset);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== sha256) {
        throw new Error(`sha256 sidecar does not match built artifact: ${asset}`);
      }
      const immutableUrl = `${base}/${tag}/${asset}`;
      return {
        target,
        url: immutableUrl,
        size: info.size,
        sha256,
        minisig_url: `${immutableUrl}.minisig`,
      } satisfies AgentManifestArtifact;
    }),
  );

  return {
    channel: "stable",
    version: options.version,
    min_supported: options.minSupported ?? options.version,
    rollout_percent: rolloutPercent,
    cohort_salt: options.cohortSalt ?? `agent-v${options.version}`,
    artifacts: artifacts.sort((a, b) => a.target.localeCompare(b.target)),
    notes_url: options.notesUrl ?? `https://github.com/Cloudgeni-ai/opengeni/releases/tag/${tag}`,
    signed_at_ms: options.signedAtMs,
    force: false,
  };
}

export async function writeAgentUpdateManifest(
  outputPath: string,
  options: GenerateAgentManifestOptions,
): Promise<AgentUpdateManifest> {
  const manifest = await generateAgentUpdateManifest(options);
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function argument(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = argument("--dir", args);
  const version = argument("--version", args);
  const signedAtMs = argument("--signed-at-ms", args);
  const releaseDownloadBase = argument("--release-download-base", args);
  if (!dir || !version || !signedAtMs || !releaseDownloadBase) {
    throw new Error(
      "usage: bun scripts/generate-agent-update-manifest.ts --dir <dist> --version <x.y.z> --signed-at-ms <epoch-ms> --release-download-base <https-url>",
    );
  }
  await writeAgentUpdateManifest(join(dir, "manifest.json"), {
    dir,
    version,
    signedAtMs: Number(signedAtMs),
    releaseDownloadBase,
    minSupported: argument("--min-supported", args),
    cohortSalt: argument("--cohort-salt", args),
    notesUrl: argument("--notes-url", args),
    ...(argument("--rollout-percent", args)
      ? { rolloutPercent: Number(argument("--rollout-percent", args)) }
      : {}),
  });
}
