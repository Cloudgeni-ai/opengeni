import type { Settings } from "@opengeni/config";
import type {
  GitHubRepository,
  GitHubRepositoryPermissions,
  GitHubUserInstallationAccess,
  GitHubUserRepositoryAccess,
} from "@opengeni/contracts";
import { createHmac, createPrivateKey, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";

const githubApiBase = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const githubTokenMintTimeoutMs = 60_000;
export const stateMaxAgeSeconds = 60 * 60;
const pkcs8PrivateKeyHeader = `-----BEGIN ${"PRIVATE KEY"}-----`;
const rsaPrivateKeyHeader = `-----BEGIN ${"RSA PRIVATE KEY"}-----`;

export class GitHubAppConfigurationError extends Error {
  constructor(readonly missing: string[]) {
    super("GitHub App is not configured");
  }
}

export class GitHubAppApiError extends Error {}

export type GitHubAppInstallationSummary = {
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  suspended: boolean;
};

export type GitHubSignedStatePayload = {
  nonce: string;
  iat: number;
  accountId?: string;
  workspaceId?: string;
  [key: string]: unknown;
};

export function githubAppMissingSettings(settings: Settings): string[] {
  const required: Record<string, string | undefined> = {
    OPENGENI_GITHUB_APP_ID: settings.githubAppId,
    OPENGENI_GITHUB_CLIENT_ID: settings.githubClientId,
    OPENGENI_GITHUB_CLIENT_SECRET: settings.githubClientSecret,
    OPENGENI_GITHUB_APP_SLUG: settings.githubAppSlug,
    OPENGENI_GITHUB_APP_PRIVATE_KEY: settings.githubAppPrivateKey,
  };
  return Object.entries(required).flatMap(([name, value]) => (value && value.trim() ? [] : [name]));
}

export function buildGitHubAppManifest(input: {
  appName: string;
  baseUrl: string;
  public: boolean;
  includeCiPermissions: boolean;
  setupUrl?: string;
}): Record<string, unknown> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const permissions: Record<string, string> = {
    metadata: "read",
    contents: "write",
    pull_requests: "write",
  };
  if (input.includeCiPermissions) {
    permissions.actions = "read";
    permissions.checks = "read";
    permissions.statuses = "write";
  }
  const manifest: Record<string, unknown> = {
    name: input.appName,
    url: base,
    redirect_url: `${base}/v1/github/app-manifest/callback`,
    callback_urls: [`${base}/v1/github/oauth/callback`],
    public: input.public,
    request_oauth_on_install: true,
    default_permissions: permissions,
  };
  if (input.setupUrl) {
    manifest.setup_url = input.setupUrl;
    manifest.setup_on_update = true;
  }
  return manifest;
}

export function personalAppManifestUrl(state: string): string {
  return `https://github.com/settings/apps/new?state=${state}`;
}

export function organizationAppManifestUrl(organization: string, state: string): string {
  return `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new?state=${state}`;
}

export function githubOAuthAuthorizeUrl(input: {
  clientId: string;
  state: string;
  redirectUri?: string;
}): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("state", input.state);
  if (input.redirectUri) {
    url.searchParams.set("redirect_uri", input.redirectUri);
  }
  return url.toString();
}

export function createSignedState(
  secret: string,
  payloadOrNow: Record<string, unknown> | number = {},
  nowArg = Math.floor(Date.now() / 1000),
): string {
  const payloadInput = typeof payloadOrNow === "number" ? {} : payloadOrNow;
  const now = typeof payloadOrNow === "number" ? payloadOrNow : nowArg;
  const payload = {
    ...payloadInput,
    nonce: randomBytes(16).toString("base64url"),
    iat: now,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signStatePayload(encoded, secret)}`;
}

export function readSignedState(
  state: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): GitHubSignedStatePayload | null {
  const [encoded, signature] = state.split(".", 2);
  if (!encoded || !signature) {
    return null;
  }
  const expected = signStatePayload(encoded, secret);
  if (!safeEqual(signature, expected)) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { iat?: unknown }).iat !== "number" ||
    typeof (payload as { nonce?: unknown }).nonce !== "string"
  ) {
    return null;
  }
  const age = now - (payload as { iat: number }).iat;
  return age >= 0 && age <= stateMaxAgeSeconds ? (payload as GitHubSignedStatePayload) : null;
}

export function verifySignedState(
  state: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  return readSignedState(state, secret, now) !== null;
}

export function envLinesFromGitHubManifestConversion(payload: Record<string, unknown>): string[] {
  const privateKey = String(payload.pem ?? "").replace(/\n/g, "\\n");
  return [
    `OPENGENI_GITHUB_APP_ID=${payload.id ?? ""}`,
    `OPENGENI_GITHUB_CLIENT_ID=${payload.client_id ?? ""}`,
    `OPENGENI_GITHUB_CLIENT_SECRET=${payload.client_secret ?? ""}`,
    `OPENGENI_GITHUB_APP_SLUG=${payload.slug ?? ""}`,
    `OPENGENI_GITHUB_WEBHOOK_SECRET=${payload.webhook_secret ?? ""}`,
    `OPENGENI_GITHUB_APP_PRIVATE_KEY="${privateKey}"`,
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

export async function listGitHubAppInstallationSummaries(
  settings: Settings,
): Promise<GitHubAppInstallationSummary[]> {
  const missing = githubAppMissingSettings(settings);
  if (missing.length > 0) {
    throw new GitHubAppConfigurationError(missing);
  }
  const jwt = await createGitHubAppJwt(settings);
  const installations = await listInstallations(jwt);
  return installations.map(installationSummaryFromPayload);
}

export async function getGitHubAppInstallationSummary(
  settings: Settings,
  installationId: number,
): Promise<GitHubAppInstallationSummary | null> {
  const installations = await listGitHubAppInstallationSummaries(settings);
  return (
    installations.find((installation) => installation.installationId === installationId) ?? null
  );
}

export async function verifyGitHubInstallationAccessForUser(
  settings: Settings,
  input: {
    code: string;
    installationId: number;
  },
): Promise<GitHubAppInstallationSummary> {
  const token = await exchangeGitHubOAuthCodeForUserToken(settings, input.code);
  const installations = await listUserAccessibleInstallations(token);
  const installation = installations.find(
    (candidate) => candidate.installationId === input.installationId,
  );
  if (!installation) {
    throw new GitHubAppApiError("GitHub installation is not accessible to the installing user");
  }
  return installation;
}

/**
 * Exchange a GitHub App user-authorization code and discover the installations
 * and repositories the user can explicitly access. Repository permission bits
 * are returned so the API can require admin authority before delegating an
 * app's write-capable installation to an OpenGeni workspace.
 */
export async function authorizeGitHubAppUser(
  settings: Settings,
  input: { code: string },
): Promise<GitHubUserInstallationAccess[]> {
  const token = await exchangeGitHubOAuthCodeForUserToken(settings, input.code);
  const installations = await listUserAccessibleInstallations(token);
  return await Promise.all(
    installations.map(async (installation) => ({
      ...installation,
      repositories: installation.suspended
        ? []
        : await listUserInstallationRepositories(token, installation),
    })),
  );
}

export async function listGitHubAppRepositories(
  settings: Settings,
  input: {
    installationIds?: number[];
  } = {},
): Promise<GitHubRepository[]> {
  const missing = githubAppMissingSettings(settings);
  if (missing.length > 0) {
    throw new GitHubAppConfigurationError(missing);
  }
  const allowedInstallations = input.installationIds ? new Set(input.installationIds) : null;
  if (allowedInstallations && allowedInstallations.size === 0) {
    return [];
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
    if (allowedInstallations && !allowedInstallations.has(installationId)) {
      continue;
    }
    const account =
      typeof installation.account === "object" && installation.account
        ? (installation.account as Record<string, unknown>)
        : {};
    const token = await createInstallationToken(jwt, { installationId });
    repositories.push(
      ...(await listInstallationRepositories(token.token, installationId, account)),
    );
  }
  repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
  return repositories;
}

export async function createGitHubAppInstallationToken(
  settings: Settings,
  input: {
    installationId: number;
    repositoryIds?: number[];
  },
): Promise<string> {
  return (await createGitHubAppInstallationTokenWithExpiry(settings, input)).token;
}

export type GitHubAppInstallationToken = {
  token: string;
  expiresAt: string | null;
};

export async function createGitHubAppInstallationTokenWithExpiry(
  settings: Settings,
  input: {
    installationId: number;
    repositoryIds?: number[];
  },
): Promise<GitHubAppInstallationToken> {
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
    const payload = await githubGet("/app/installations", token, {
      per_page: "100",
      page: String(page),
    });
    if (!Array.isArray(payload)) {
      throw new GitHubAppApiError("GitHub returned an invalid installations payload");
    }
    out.push(
      ...payload.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)),
      ),
    );
    if (payload.length < 100) {
      return out;
    }
  }
}

async function exchangeGitHubOAuthCodeForUserToken(
  settings: Settings,
  code: string,
): Promise<string> {
  if (!settings.githubClientId || !settings.githubClientSecret) {
    throw new GitHubAppConfigurationError(githubAppMissingSettings(settings));
  }
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: settings.githubClientId,
      client_secret: settings.githubClientSecret,
      code,
    }),
  });
  if (!response.ok) {
    throw new GitHubAppApiError(await githubErrorMessage(response));
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || typeof payload.access_token !== "string") {
    throw new GitHubAppApiError("GitHub returned an invalid OAuth token payload");
  }
  return payload.access_token;
}

async function listUserAccessibleInstallations(
  token: string,
): Promise<GitHubAppInstallationSummary[]> {
  const out: GitHubAppInstallationSummary[] = [];
  for (let page = 1; ; page += 1) {
    const payload = await githubGet("/user/installations", token, {
      per_page: "100",
      page: String(page),
    });
    const installations: unknown[] | null =
      payload && typeof payload === "object" && Array.isArray(payload.installations)
        ? (payload.installations as unknown[])
        : null;
    if (!installations) {
      throw new GitHubAppApiError("GitHub returned an invalid user installations payload");
    }
    out.push(
      ...installations
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        )
        .map(installationSummaryFromPayload),
    );
    if (installations.length < 100) {
      return out;
    }
  }
}

async function listUserInstallationRepositories(
  token: string,
  installation: GitHubAppInstallationSummary,
): Promise<GitHubUserRepositoryAccess[]> {
  const out: GitHubUserRepositoryAccess[] = [];
  const account = {
    ...(installation.accountLogin ? { login: installation.accountLogin } : {}),
    ...(installation.accountType ? { type: installation.accountType } : {}),
  };
  for (let page = 1; ; page += 1) {
    const payload = await githubGet(
      `/user/installations/${installation.installationId}/repositories`,
      token,
      { per_page: "100", page: String(page) },
    );
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !Array.isArray(payload.repositories)
    ) {
      throw new GitHubAppApiError(
        "GitHub returned an invalid user installation repositories payload",
      );
    }
    for (const repository of payload.repositories) {
      if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
        continue;
      }
      const record = repository as Record<string, unknown>;
      out.push({
        ...repositoryFromPayload(record, installation.installationId, account),
        permissions: repositoryPermissionsFromPayload(record.permissions),
      });
    }
    if (payload.repositories.length < 100) {
      return out;
    }
  }
}

async function createInstallationToken(
  appJwt: string,
  input: {
    installationId: number;
    repositoryIds?: number[];
  },
): Promise<GitHubAppInstallationToken> {
  const scoped = input.repositoryIds && input.repositoryIds.length > 0;
  const response = await fetch(
    `${githubApiBase}/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(appJwt),
        ...(scoped ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(githubTokenMintTimeoutMs),
      ...(scoped ? { body: JSON.stringify({ repository_ids: input.repositoryIds }) } : {}),
    },
  );
  if (!response.ok) {
    throw new GitHubAppApiError(await githubErrorMessage(response));
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || typeof payload.token !== "string") {
    throw new GitHubAppApiError("GitHub returned an invalid installation token payload");
  }
  return {
    token: payload.token,
    expiresAt: typeof payload.expires_at === "string" ? payload.expires_at : null,
  };
}

async function listInstallationRepositories(
  token: string,
  installationId: number,
  account: Record<string, unknown>,
): Promise<GitHubRepository[]> {
  const out: GitHubRepository[] = [];
  for (let page = 1; ; page += 1) {
    const payload = await githubGet("/installation/repositories", token, {
      per_page: "100",
      page: String(page),
    });
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !Array.isArray(payload.repositories)
    ) {
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

function installationSummaryFromPayload(
  payload: Record<string, unknown>,
): GitHubAppInstallationSummary {
  const installationId = asInt(payload.id);
  if (installationId === null) {
    throw new GitHubAppApiError("GitHub returned an installation without id");
  }
  const account =
    typeof payload.account === "object" && payload.account
      ? (payload.account as Record<string, unknown>)
      : {};
  return {
    installationId,
    accountLogin: typeof account.login === "string" ? account.login : null,
    accountType: typeof account.type === "string" ? account.type : null,
    suspended: Boolean(payload.suspended_at),
  };
}

async function githubGet(
  path: string,
  token: string,
  params: Record<string, string>,
): Promise<any> {
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

function repositoryFromPayload(
  payload: Record<string, unknown>,
  installationId: number,
  account: Record<string, unknown>,
): GitHubRepository {
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

function repositoryPermissionsFromPayload(payload: unknown): GitHubRepositoryPermissions {
  const permissions =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return {
    admin: permissions.admin === true,
    maintain: permissions.maintain === true,
    push: permissions.push === true,
    triage: permissions.triage === true,
    pull: permissions.pull === true,
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
  if (!privateKey || privateKey.startsWith(pkcs8PrivateKeyHeader)) {
    return privateKey;
  }
  if (privateKey.startsWith(rsaPrivateKeyHeader)) {
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
