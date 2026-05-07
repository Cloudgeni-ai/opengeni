import type { Settings } from "@infra-agents/config";
import type { GitHubRepository } from "@infra-agents/contracts";
import { createHmac, createPrivateKey, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";

const githubApiBase = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const stateMaxAgeSeconds = 60 * 60;

export class GitHubAppConfigurationError extends Error {
  constructor(readonly missing: string[]) {
    super("GitHub App is not configured");
  }
}

export class GitHubAppApiError extends Error {}

export function githubAppMissingSettings(settings: Settings): string[] {
  const required: Record<string, string | undefined> = {
    INFRA_AGENT_GITHUB_APP_ID: settings.githubAppId,
    INFRA_AGENT_GITHUB_CLIENT_ID: settings.githubClientId,
    INFRA_AGENT_GITHUB_CLIENT_SECRET: settings.githubClientSecret,
    INFRA_AGENT_GITHUB_APP_SLUG: settings.githubAppSlug,
    INFRA_AGENT_GITHUB_APP_PRIVATE_KEY: settings.githubAppPrivateKey,
  };
  return Object.entries(required).flatMap(([name, value]) => value && value.trim() ? [] : [name]);
}

export function buildGitHubAppManifest(input: {
  appName: string;
  baseUrl: string;
  public: boolean;
  includeCiPermissions: boolean;
}): Record<string, unknown> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const permissions: Record<string, string> = {
    metadata: "read",
    contents: "write",
    pull_requests: "write",
  };
  const events = ["pull_request", "push"];
  if (input.includeCiPermissions) {
    permissions.actions = "read";
    permissions.checks = "read";
    permissions.statuses = "write";
    events.push("check_run", "workflow_run");
  }
  const manifest: Record<string, unknown> = {
    name: input.appName,
    url: base,
    redirect_url: `${base}/v1/github/app-manifest/callback`,
    public: input.public,
    request_oauth_on_install: false,
    default_permissions: permissions,
  };
  if (isPublicHttpsUrl(base)) {
    manifest.hook_attributes = {
      url: `${base}/v1/github/webhook`,
      active: true,
    };
    manifest.default_events = events;
  }
  return manifest;
}

export function personalAppManifestUrl(state: string): string {
  return `https://github.com/settings/apps/new?state=${state}`;
}

export function organizationAppManifestUrl(organization: string, state: string): string {
  return `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new?state=${state}`;
}

export function createSignedState(secret: string, now = Math.floor(Date.now() / 1000)): string {
  const payload = {
    nonce: randomBytes(16).toString("base64url"),
    iat: now,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signStatePayload(encoded, secret)}`;
}

export function verifySignedState(state: string, secret: string, now = Math.floor(Date.now() / 1000)): boolean {
  const [encoded, signature] = state.split(".", 2);
  if (!encoded || !signature) {
    return false;
  }
  const expected = signStatePayload(encoded, secret);
  if (!safeEqual(signature, expected)) {
    return false;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object" || typeof (payload as { iat?: unknown }).iat !== "number") {
    return false;
  }
  const age = now - (payload as { iat: number }).iat;
  return age >= 0 && age <= stateMaxAgeSeconds;
}

export function envLinesFromGitHubManifestConversion(payload: Record<string, unknown>): string[] {
  const privateKey = String(payload.pem ?? "").replace(/\n/g, "\\n");
  return [
    `INFRA_AGENT_GITHUB_APP_ID=${payload.id ?? ""}`,
    `INFRA_AGENT_GITHUB_CLIENT_ID=${payload.client_id ?? ""}`,
    `INFRA_AGENT_GITHUB_CLIENT_SECRET=${payload.client_secret ?? ""}`,
    `INFRA_AGENT_GITHUB_APP_SLUG=${payload.slug ?? ""}`,
    `INFRA_AGENT_GITHUB_WEBHOOK_SECRET=${payload.webhook_secret ?? ""}`,
    `INFRA_AGENT_GITHUB_APP_PRIVATE_KEY="${privateKey}"`,
  ];
}

export async function convertGitHubAppManifest(code: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${githubApiBase}/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: githubHeaders(undefined),
  });
  if (!response.ok) {
    throw new GitHubAppApiError(await githubErrorMessage(response));
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GitHubAppApiError("GitHub returned an invalid manifest conversion payload");
  }
  return payload as Record<string, unknown>;
}

export async function listGitHubAppRepositories(settings: Settings): Promise<GitHubRepository[]> {
  const missing = githubAppMissingSettings(settings);
  if (missing.length > 0) {
    throw new GitHubAppConfigurationError(missing);
  }
  const jwt = await createGitHubAppJwt(settings);
  const installations = await listInstallations(jwt);
  const repositories: GitHubRepository[] = [];
  for (const installation of installations) {
    if (installation.suspended_at) {
      continue;
    }
    const installationId = asInt(installation.id);
    if (installationId === null) {
      continue;
    }
    const account = typeof installation.account === "object" && installation.account ? installation.account as Record<string, unknown> : {};
    const token = await createInstallationToken(jwt, { installationId });
    repositories.push(...await listInstallationRepositories(token, installationId, account));
  }
  repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
  return repositories;
}

export async function createGitHubAppInstallationToken(settings: Settings, input: {
  installationId: number;
  repositoryIds?: number[];
}): Promise<string> {
  const missing = githubAppMissingSettings(settings);
  if (missing.length > 0) {
    throw new GitHubAppConfigurationError(missing);
  }
  const jwt = await createGitHubAppJwt(settings);
  return await createInstallationToken(jwt, input);
}

export function githubAppBotIdentity(settings: Settings): { name: string; email: string } | null {
  const appId = settings.githubAppId?.trim();
  const slug = settings.githubAppSlug?.trim();
  if (!appId || !slug) {
    return null;
  }
  const login = `${slug}[bot]`;
  return {
    name: login,
    email: `${appId}+${login}@users.noreply.github.com`,
  };
}

async function createGitHubAppJwt(settings: Settings): Promise<string> {
  const privateKey = normalizeGitHubAppPrivateKey(settings.githubAppPrivateKey ?? "");
  const appId = settings.githubAppId?.trim();
  if (!appId || !privateKey) {
    throw new GitHubAppConfigurationError(githubAppMissingSettings(settings));
  }
  const key = await importPKCS8(privateKey, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(appId)
    .sign(key);
}

async function listInstallations(token: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let page = 1; ; page += 1) {
    const payload = await githubGet("/app/installations", token, { per_page: "100", page: String(page) });
    if (!Array.isArray(payload)) {
      throw new GitHubAppApiError("GitHub returned an invalid installations payload");
    }
    out.push(...payload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))));
    if (payload.length < 100) {
      return out;
    }
  }
}

async function createInstallationToken(appJwt: string, input: {
  installationId: number;
  repositoryIds?: number[];
}): Promise<string> {
  const scoped = input.repositoryIds && input.repositoryIds.length > 0;
  const response = await fetch(`${githubApiBase}/app/installations/${input.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      ...githubHeaders(appJwt),
      ...(scoped ? { "Content-Type": "application/json" } : {}),
    },
    ...(scoped ? { body: JSON.stringify({ repository_ids: input.repositoryIds }) } : {}),
  });
  if (!response.ok) {
    throw new GitHubAppApiError(await githubErrorMessage(response));
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || typeof payload.token !== "string") {
    throw new GitHubAppApiError("GitHub returned an invalid installation token payload");
  }
  return payload.token;
}

async function listInstallationRepositories(token: string, installationId: number, account: Record<string, unknown>): Promise<GitHubRepository[]> {
  const out: GitHubRepository[] = [];
  for (let page = 1; ; page += 1) {
    const payload = await githubGet("/installation/repositories", token, { per_page: "100", page: String(page) });
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.repositories)) {
      throw new GitHubAppApiError("GitHub returned an invalid repositories payload");
    }
    for (const repo of payload.repositories) {
      if (repo && typeof repo === "object" && !Array.isArray(repo)) {
        out.push(repositoryFromPayload(repo as Record<string, unknown>, installationId, account));
      }
    }
    if (payload.repositories.length < 100) {
      return out;
    }
  }
}

async function githubGet(path: string, token: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${githubApiBase}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    throw new GitHubAppApiError(await githubErrorMessage(response));
  }
  return await response.json();
}

function repositoryFromPayload(payload: Record<string, unknown>, installationId: number, account: Record<string, unknown>): GitHubRepository {
  const id = asInt(payload.id);
  const fullName = String(payload.full_name ?? "");
  if (id === null || !fullName) {
    throw new GitHubAppApiError("GitHub returned a repository without id/full_name");
  }
  return {
    id,
    installationId,
    fullName,
    name: String(payload.name ?? fullName.split("/").at(-1) ?? fullName),
    private: Boolean(payload.private),
    htmlUrl: String(payload.html_url ?? `https://github.com/${fullName}`),
    cloneUrl: String(payload.clone_url ?? `https://github.com/${fullName}.git`),
    defaultBranch: String(payload.default_branch ?? "main"),
    accountLogin: String(account.login ?? fullName.split("/", 1)[0]),
    accountType: typeof account.type === "string" ? account.type : null,
  };
}

function githubHeaders(token?: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "X-GitHub-Api-Version": githubApiVersion,
  };
}

async function githubErrorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    if (payload && typeof payload === "object" && "message" in payload) {
      return `GitHub API ${response.status}: ${String(payload.message)}`;
    }
  } catch {
    // fall through
  }
  return `GitHub API ${response.status}: ${await response.text()}`;
}

export function normalizeGitHubAppPrivateKey(value: string): string {
  const privateKey = value.trim().replace(/\\n/g, "\n");
  if (!privateKey || privateKey.startsWith("-----BEGIN PRIVATE KEY-----")) {
    return privateKey;
  }
  if (privateKey.startsWith("-----BEGIN RSA PRIVATE KEY-----")) {
    return createPrivateKey(privateKey).export({ type: "pkcs8", format: "pem" }).toString();
  }
  return privateKey;
}

function signStatePayload(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return false;
    }
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) {
      return false;
    }
    if (/^(10\.|127\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)/.test(host)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
