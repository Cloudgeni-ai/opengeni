import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SiteCapabilityManifest,
  type SiteCapabilityManifest as SiteManifest,
} from "@opengeni/contracts";
import { OpenGeniClient } from "@opengeni/sdk/artifacts";

export type SitePublisherConfig = {
  schemaVersion: 1;
  apiUrl: string;
  workspaceId: string;
  operationId: string;
  sourceHtml: string;
  slug?: string;
  title: string;
  description?: string | null;
  manifest: SiteManifest;
  apiKeyEnvironment: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]*$/u;
const CONFIG_KEYS = new Set([
  "schemaVersion",
  "apiUrl",
  "workspaceId",
  "operationId",
  "sourceHtml",
  "slug",
  "title",
  "description",
  "manifest",
  "apiKeyEnvironment",
]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Site publisher config must be an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
  return value;
}

export function parseSitePublisherConfig(value: unknown): SitePublisherConfig {
  const input = object(value);
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`unknown Site publisher config field: ${key}`);
  }
  if (input.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const workspaceId = text(input.workspaceId, "workspaceId", 64);
  const operationId = text(input.operationId, "operationId", 64);
  if (!UUID.test(workspaceId) || !UUID.test(operationId)) {
    throw new Error("workspaceId and operationId must be UUIDs");
  }
  const parsedUrl = new URL(text(input.apiUrl, "apiUrl", 2_048));
  if (
    !(["http:", "https:"] as string[]).includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error("apiUrl must be an http(s) URL without credentials");
  }
  const apiKeyEnvironment = text(input.apiKeyEnvironment, "apiKeyEnvironment", 128);
  if (!ENVIRONMENT_KEY.test(apiKeyEnvironment)) {
    throw new Error("apiKeyEnvironment must name an environment variable");
  }
  const description = input.description;
  if (description !== undefined && description !== null && typeof description !== "string") {
    throw new Error("description must be a string or null");
  }
  const slug = input.slug;
  if (slug !== undefined && (typeof slug !== "string" || slug.length < 1 || slug.length > 96)) {
    throw new Error("slug must be a bounded string");
  }
  return {
    schemaVersion: 1,
    apiUrl: parsedUrl.toString().replace(/\/$/u, ""),
    workspaceId,
    operationId,
    sourceHtml: text(input.sourceHtml, "sourceHtml", 4_096),
    ...(slug ? { slug } : {}),
    title: text(input.title, "title", 512),
    ...(description !== undefined ? { description } : {}),
    manifest: SiteCapabilityManifest.parse(input.manifest),
    apiKeyEnvironment,
  };
}

export async function publishSiteFromConfig(config: SitePublisherConfig) {
  const apiKey = process.env[config.apiKeyEnvironment];
  if (!apiKey) throw new Error(`${config.apiKeyEnvironment} is required`);
  const html = await readFile(resolve(config.sourceHtml), "utf8");
  const client = new OpenGeniClient({ baseUrl: config.apiUrl, apiKey });
  const artifact = await client.createWorkspaceArtifact(config.workspaceId, {
    ...(config.slug ? { slug: config.slug } : {}),
    title: config.title,
    ...(config.description !== undefined ? { description: config.description } : {}),
    html,
    idempotencyKey: `site-artifact:${config.operationId}`,
  });
  const published = await client.publishSite(config.workspaceId, artifact.artifact.id, {
    operationId: config.operationId,
    expectedCurrentReleaseId: null,
    artifactVersionId: artifact.version.id,
    manifest: config.manifest,
    reason: "Initial Site release from the trusted Sites publisher",
  });
  return {
    artifactId: artifact.artifact.id,
    artifactVersionId: artifact.version.id,
    siteId: published.site.id,
    releaseId: published.release.id,
    sitePath: `/workspaces/${config.workspaceId}/sites/${published.site.id}/run`,
  };
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Usage: bun scripts/sites-publish.ts <config.json>");
  const config = parseSitePublisherConfig(JSON.parse(await readFile(resolve(configPath), "utf8")));
  process.stdout.write(`${JSON.stringify(await publishSiteFromConfig(config), null, 2)}\n`);
}

if (import.meta.main) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
