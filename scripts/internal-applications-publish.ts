import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  InternalApplicationBundleManifest,
  RegisterInternalApplicationBundleRequest,
  type InternalApplicationBundleManifest as BundleManifest,
} from "@opengeni/contracts/internal-applications";
import { stableJson } from "@opengeni/contracts";
import { OpenGeniClient } from "@opengeni/sdk";

export type InternalApplicationPublisherConfig = {
  schemaVersion: 1;
  apiUrl: string;
  workspaceId: string;
  applicationId: string;
  applicationRevisionId: string;
  sourceDirectory: string;
  dockerfile: string;
  imageReference: string;
  architecture: "amd64" | "arm64";
  runtime: { command: string[]; workingDirectory: string };
  health: { path: string; port: number };
  configurationKeys: string[];
  staticAssetsDigest: `sha256:${string}` | null;
  migrationsDigest: `sha256:${string}` | null;
  apiKeyEnvironment: string;
};

const configKeys = new Set([
  "schemaVersion",
  "apiUrl",
  "workspaceId",
  "applicationId",
  "applicationRevisionId",
  "sourceDirectory",
  "dockerfile",
  "imageReference",
  "architecture",
  "runtime",
  "health",
  "configurationKeys",
  "staticAssetsDigest",
  "migrationsDigest",
  "apiKeyEnvironment",
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const environmentKeyPattern = /^[A-Z_][A-Z0-9_]*$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 2_048): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    throw new Error(`${label} must be a non-empty bounded string`);
  return value;
}

function digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !digestPattern.test(value))
    throw new Error(`${label} must be a sha256 digest`);
  return value as `sha256:${string}`;
}

export function parseInternalApplicationPublisherConfig(
  value: unknown,
): InternalApplicationPublisherConfig {
  const input = record(value, "publisher config");
  for (const key of Object.keys(input))
    if (!configKeys.has(key)) throw new Error(`unknown publisher config field: ${key}`);
  if (input.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const runtime = record(input.runtime, "runtime");
  const health = record(input.health, "health");
  const ids = [input.workspaceId, input.applicationId, input.applicationRevisionId];
  if (ids.some((candidate) => typeof candidate !== "string" || !uuidPattern.test(candidate)))
    throw new Error("workspace, application, and revision ids must be UUIDs");
  const apiUrl = text(input.apiUrl, "apiUrl");
  const parsedUrl = new URL(apiUrl);
  if (
    !(["http:", "https:"] as string[]).includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password
  )
    throw new Error("apiUrl must be an http(s) URL without credentials");
  const command = runtime.command;
  if (
    !Array.isArray(command) ||
    command.length < 1 ||
    command.length > 64 ||
    command.some((part) => typeof part !== "string" || part.length > 4_096)
  )
    throw new Error("runtime.command must be a bounded string array");
  const configurationKeys = input.configurationKeys;
  if (
    !Array.isArray(configurationKeys) ||
    configurationKeys.length > 256 ||
    configurationKeys.some((key) => typeof key !== "string" || !environmentKeyPattern.test(key))
  )
    throw new Error("configurationKeys must contain environment variable names");
  const port = health.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("health.port must be a valid port");
  const healthPath = text(health.path, "health.path", 1_024);
  if (!healthPath.startsWith("/")) throw new Error("health.path must start with /");
  const architecture = input.architecture;
  if (architecture !== "amd64" && architecture !== "arm64")
    throw new Error("architecture must be amd64 or arm64");
  const apiKeyEnvironment = input.apiKeyEnvironment ?? "OPENGENI_API_KEY";
  if (typeof apiKeyEnvironment !== "string" || !environmentKeyPattern.test(apiKeyEnvironment))
    throw new Error("apiKeyEnvironment must be an environment variable name");
  return {
    schemaVersion: 1,
    apiUrl,
    workspaceId: input.workspaceId as string,
    applicationId: input.applicationId as string,
    applicationRevisionId: input.applicationRevisionId as string,
    sourceDirectory: text(input.sourceDirectory, "sourceDirectory"),
    dockerfile:
      input.dockerfile === undefined ? "Dockerfile" : text(input.dockerfile, "dockerfile"),
    imageReference: text(input.imageReference, "imageReference", 1_024),
    architecture,
    runtime: {
      command: command as string[],
      workingDirectory: text(runtime.workingDirectory, "runtime.workingDirectory", 1_024),
    },
    health: { path: healthPath, port },
    configurationKeys: configurationKeys as string[],
    staticAssetsDigest:
      input.staticAssetsDigest === undefined || input.staticAssetsDigest === null
        ? null
        : digest(input.staticAssetsDigest, "staticAssetsDigest"),
    migrationsDigest:
      input.migrationsDigest === undefined || input.migrationsDigest === null
        ? null
        : digest(input.migrationsDigest, "migrationsDigest"),
    apiKeyEnvironment,
  };
}

export function sha256Digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function internalApplicationBundleManifest(input: {
  config: InternalApplicationPublisherConfig;
  imageDigest: `sha256:${string}`;
  sbomDigest: `sha256:${string}`;
  provenanceDigest: `sha256:${string}`;
}): BundleManifest {
  return InternalApplicationBundleManifest.parse({
    schemaVersion: 1,
    image: {
      reference: input.config.imageReference,
      digest: input.imageDigest,
      architecture: input.config.architecture,
    },
    staticAssetsDigest: input.config.staticAssetsDigest,
    migrationsDigest: input.config.migrationsDigest,
    runtime: input.config.runtime,
    health: input.config.health,
    configurationKeys: input.config.configurationKeys,
    sbomDigest: input.sbomDigest,
    provenanceDigest: input.provenanceDigest,
  });
}

type CommandResult = { exitCode: number; stdout: string; stderr: string };

async function run(command: string[], cwd?: string): Promise<CommandResult> {
  const process = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: processEnvWithoutBuildSecrets(),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function processEnvWithoutBuildSecrets(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => {
      if (value === undefined || /(?:TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|SECRET)/iu.test(key))
        return [];
      return [[key, value]];
    }),
  );
}

async function requireCommand(command: string, cwd?: string) {
  const result = await run([command, "--version"], cwd);
  if (result.exitCode !== 0)
    throw new Error(`${command} is required for trusted bundle publication`);
}

function boundedDiagnostic(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().slice(0, 2_048);
}

async function runOrThrow(command: string[], cwd?: string) {
  const result = await run(command, cwd);
  if (result.exitCode !== 0)
    throw new Error(
      `${command[0]} exited ${result.exitCode}: ${boundedDiagnostic(result.stderr || result.stdout)}`,
    );
  return result;
}

export async function publishInternalApplicationBundle(config: InternalApplicationPublisherConfig) {
  const sourceDirectory = resolve(config.sourceDirectory);
  const dockerfile = isAbsolute(config.dockerfile)
    ? config.dockerfile
    : resolve(sourceDirectory, config.dockerfile);
  if (dirname(dockerfile) !== sourceDirectory && !dockerfile.startsWith(`${sourceDirectory}/`))
    throw new Error("dockerfile must remain inside sourceDirectory");
  const apiKey = process.env[config.apiKeyEnvironment];
  if (!apiKey) throw new Error(`${config.apiKeyEnvironment} is required`);
  await Promise.all([
    requireCommand("docker", sourceDirectory),
    requireCommand("syft", sourceDirectory),
  ]);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "opengeni-internal-app-publish-"));
  try {
    const metadataPath = join(temporaryDirectory, "build-metadata.json");
    const sbomPath = join(temporaryDirectory, "sbom.spdx.json");
    await runOrThrow(
      [
        "docker",
        "buildx",
        "build",
        "--platform",
        `linux/${config.architecture}`,
        "--file",
        dockerfile,
        "--tag",
        config.imageReference,
        "--push",
        "--provenance=mode=max",
        "--sbom=true",
        "--metadata-file",
        metadataPath,
        sourceDirectory,
      ],
      sourceDirectory,
    );
    const metadataBytes = await readFile(metadataPath);
    const metadata = JSON.parse(metadataBytes.toString("utf8")) as Record<string, unknown>;
    const imageDigest = digest(metadata["containerimage.digest"], "containerimage.digest");
    await runOrThrow(
      ["syft", `${config.imageReference}@${imageDigest}`, "-o", `spdx-json=${sbomPath}`],
      sourceDirectory,
    );
    const sbomBytes = await readFile(sbomPath);
    const provenance = metadata["buildx.build.provenance"] ?? metadata;
    const manifest = internalApplicationBundleManifest({
      config,
      imageDigest,
      sbomDigest: sha256Digest(sbomBytes),
      provenanceDigest: sha256Digest(stableJson(provenance)),
    });
    const request = RegisterInternalApplicationBundleRequest.parse({
      operationId: crypto.randomUUID(),
      applicationRevisionId: config.applicationRevisionId,
      digest: sha256Digest(stableJson(manifest)),
      manifest,
    });
    const client = new OpenGeniClient({ baseUrl: config.apiUrl, apiKey });
    const bundle = await client.registerInternalApplicationBundle(
      config.workspaceId,
      config.applicationId,
      request,
    );
    return {
      bundle,
      imageDigest,
      sbomDigest: manifest.sbomDigest,
      provenanceDigest: manifest.provenanceDigest,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath)
    throw new Error("Usage: bun scripts/internal-applications-publish.ts <config.json>");
  const config = parseInternalApplicationPublisherConfig(
    JSON.parse(await readFile(resolve(configPath), "utf8")),
  );
  const receipt = await publishInternalApplicationBundle(config);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (import.meta.main) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
