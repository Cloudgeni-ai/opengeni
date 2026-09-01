import type { Settings } from "@opengeni/config";
import type {
  GitHubAppRepositoryBranchPage,
  GitHubInstallationBindingCandidate,
  GitHubInstallationBindingProof,
  GitHubRepository,
  GitHubRepositoryPermissions,
  GitHubUserInstallationAccess,
  GitHubUserRepositoryAccess,
} from "@opengeni/contracts";
import { readResponseTextBounded } from "@opengeni/network";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";

const githubApiBase = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const githubTokenMintTimeoutMs = 60_000;
/** Bound for the server-side repository-id lookup at turn start (mint + read). */
export const githubRepositoryLookupTimeoutMs = 10_000;
export const githubRepositoryBranchesTimeoutMs = 10_000;
const githubRepositoryBranchesResponseMaxBytes = 256 * 1024;
const githubInstallationTokenResponseMaxBytes = 64 * 1024;
const githubErrorResponseMaxBytes = 64 * 1024;
const githubErrorMessageMaxLength = 1024;
export const stateMaxAgeSeconds = 60 * 60;
const pkcs8PrivateKeyHeader = `-----BEGIN ${"PRIVATE KEY"}-----`;
const rsaPrivateKeyHeader = `-----BEGIN ${"RSA PRIVATE KEY"}-----`;

const PERSONAL_GITHUB_GIT_BROKER_TOKEN_PREFIX = "oggh1";
const PERSONAL_GITHUB_GIT_BROKER_KEY_CONTEXT = "opengeni:personal-github:git-broker:v1";
export const PERSONAL_GITHUB_GIT_BROKER_TOKEN_TTL_SECONDS = 5 * 60;

export type PersonalGitHubGitBrokerRepositoryClaim = {
  repositoryId: string;
  fullName: string;
  canonicalUrl: string;
  ref: string;
  access: "read" | "write";
  selectionGeneration: number;
  routeId: string;
};

export type PersonalGitHubGitBrokerClaims = {
  version: 1;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  rootSessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  originWorkspaceId: string;
  connectionId: string;
  connectionAuthorityGeneration: number;
  ownerSubjectId: string;
  credentialBindingId: string;
  selectionGeneration: number;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

export function personalGitHubGitBrokerRouteId(
  secret: string,
  input: Omit<PersonalGitHubGitBrokerClaims, "nonce" | "issuedAt" | "expiresAt"> & {
    repository: Omit<PersonalGitHubGitBrokerRepositoryClaim, "routeId">;
  },
): string {
  const hmac = createHmac("sha256", personalGitHubGitBrokerKey(secret));
  for (const value of [
    String(input.version),
    input.accountId,
    input.workspaceId,
    input.sessionId,
    input.rootSessionId,
    input.turnId,
    input.attemptId,
    String(input.executionGeneration),
    input.originWorkspaceId,
    input.connectionId,
    String(input.connectionAuthorityGeneration),
    input.ownerSubjectId,
    input.credentialBindingId,
    String(input.selectionGeneration),
    input.repository.repositoryId,
    input.repository.fullName,
    input.repository.canonicalUrl,
    input.repository.ref,
    input.repository.access,
    String(input.repository.selectionGeneration),
  ]) {
    const bytes = Buffer.from(value, "utf8");
    hmac.update(Buffer.from(String(bytes.byteLength), "ascii"));
    hmac.update(":");
    hmac.update(bytes);
    hmac.update(";");
  }
  return hmac.digest("base64url");
}

/**
 * Seal exact Git broker authority into a confidential, authenticated bearer.
 * The payload is encrypted rather than merely signed so tenant, session,
 * connection, and repository identities are not readable from the sandbox's
 * short-lived token file.
 */
export function sealPersonalGitHubGitBrokerClaims(
  secret: string,
  claims: PersonalGitHubGitBrokerClaims,
): string {
  assertPersonalGitHubGitBrokerClaims(claims);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", personalGitHubGitBrokerKey(secret), iv);
  cipher.setAAD(Buffer.from(PERSONAL_GITHUB_GIT_BROKER_TOKEN_PREFIX, "ascii"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), "utf8"), cipher.final()]);
  return [
    PERSONAL_GITHUB_GIT_BROKER_TOKEN_PREFIX,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function openPersonalGitHubGitBrokerClaims(
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): PersonalGitHubGitBrokerClaims | null {
  const [prefix, encodedIv, encodedCiphertext, encodedTag, extra] = token.split(".");
  if (
    prefix !== PERSONAL_GITHUB_GIT_BROKER_TOKEN_PREFIX ||
    !encodedIv ||
    !encodedCiphertext ||
    !encodedTag ||
    extra !== undefined
  ) {
    return null;
  }
  try {
    const iv = Buffer.from(encodedIv, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    if (iv.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength > 4_096) {
      return null;
    }
    const decipher = createDecipheriv("aes-256-gcm", personalGitHubGitBrokerKey(secret), iv);
    decipher.setAAD(Buffer.from(PERSONAL_GITHUB_GIT_BROKER_TOKEN_PREFIX, "ascii"));
    decipher.setAuthTag(tag);
    const payload = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
    ) as unknown;
    assertPersonalGitHubGitBrokerClaims(payload);
    if (payload.issuedAt > nowSeconds + 60 || nowSeconds >= payload.expiresAt) return null;
    if (payload.expiresAt - payload.issuedAt > PERSONAL_GITHUB_GIT_BROKER_TOKEN_TTL_SECONDS) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function personalGitHubGitBrokerKey(secret: string): Buffer {
  const normalized = secret.trim();
  if (!normalized) throw new Error("personal GitHub Git broker signing secret is unavailable");
  return createHash("sha256")
    .update(PERSONAL_GITHUB_GIT_BROKER_KEY_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(normalized, "utf8")
    .digest();
}

function assertPersonalGitHubGitBrokerClaims(
  value: unknown,
): asserts value is PersonalGitHubGitBrokerClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid personal GitHub Git broker claims");
  }
  const claims = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "version",
    "accountId",
    "workspaceId",
    "sessionId",
    "rootSessionId",
    "turnId",
    "attemptId",
    "executionGeneration",
    "originWorkspaceId",
    "connectionId",
    "connectionAuthorityGeneration",
    "ownerSubjectId",
    "credentialBindingId",
    "selectionGeneration",
    "nonce",
    "issuedAt",
    "expiresAt",
  ]);
  const strings = [
    "accountId",
    "workspaceId",
    "sessionId",
    "rootSessionId",
    "turnId",
    "attemptId",
    "originWorkspaceId",
    "connectionId",
    "ownerSubjectId",
    "credentialBindingId",
    "nonce",
  ];
  if (
    claims.version !== 1 ||
    strings.some(
      (field) =>
        typeof claims[field] !== "string" ||
        claims[field].length === 0 ||
        claims[field].length > (field === "ownerSubjectId" ? 512 : 128),
    ) ||
    !positiveIntegerClaim(claims.executionGeneration) ||
    !positiveIntegerClaim(claims.connectionAuthorityGeneration) ||
    !positiveIntegerClaim(claims.selectionGeneration) ||
    !positiveIntegerClaim(claims.issuedAt) ||
    !positiveIntegerClaim(claims.expiresAt) ||
    Object.keys(claims).some((key) => !expectedKeys.has(key))
  ) {
    throw new Error("invalid personal GitHub Git broker claims");
  }
}

function positiveIntegerClaim(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export class GitHubAppConfigurationError extends Error {
  constructor(readonly missing: string[]) {
    super("GitHub App is not configured");
  }
}

export class GitHubAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export type GitHubInstallationAuthorityFailure =
  | "authority_denied"
  | "authority_unavailable"
  | "installation_missing"
  | "installation_suspended"
  | "repository_access_empty";

export class GitHubInstallationAuthorityError extends GitHubAppApiError {
  constructor(
    readonly reason: GitHubInstallationAuthorityFailure,
    message: string,
    status: number | null = null,
  ) {
    super(message, status);
  }
}

export type GitHubAppInstallationSummary = {
  installationId: number;
  accountId: number;
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

export function prReviewGitHubAppMissingSettings(settings: Settings): string[] {
  const required: Record<string, string | undefined> = {
    OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET: settings.githubAppManifestStateSecret,
    OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: settings.environmentsEncryptionKey,
    OPENGENI_PR_REVIEW_GITHUB_APP_ID: settings.prReviewGithubAppId,
    OPENGENI_PR_REVIEW_GITHUB_CLIENT_ID: settings.prReviewGithubClientId,
    OPENGENI_PR_REVIEW_GITHUB_CLIENT_SECRET: settings.prReviewGithubClientSecret,
    OPENGENI_PR_REVIEW_GITHUB_APP_SLUG: settings.prReviewGithubAppSlug,
    OPENGENI_PR_REVIEW_GITHUB_WEBHOOK_SECRET: settings.prReviewGithubWebhookSecret,
    OPENGENI_PR_REVIEW_GITHUB_APP_PRIVATE_KEY: settings.prReviewGithubAppPrivateKey,
  };
  return Object.entries(required).flatMap(([name, value]) => (value && value.trim() ? [] : [name]));
}

/** Project the separately configured review App onto the ordinary GitHub App
 * authority client. This keeps its OAuth, signing, webhook, and installation
 * identity disjoint from the platform GitHub App while reusing the same
 * personal-owner / organization-owner proof implementation. */
export function settingsForPrReviewGitHubApp(settings: Settings): Settings {
  return {
    ...settings,
    githubAppId: settings.prReviewGithubAppId,
    githubClientId: settings.prReviewGithubClientId,
    githubClientSecret: settings.prReviewGithubClientSecret,
    githubAppSlug: settings.prReviewGithubAppSlug,
    githubWebhookSecret: settings.prReviewGithubWebhookSecret,
    githubAppPrivateKey: settings.prReviewGithubAppPrivateKey,
  };
}

export type GitHubAppSigningSettings = Pick<Settings, "githubAppId" | "githubAppPrivateKey">;

function githubAppTokenMissingSettings(settings: GitHubAppSigningSettings): string[] {
  const required: Record<string, string | undefined> = {
    OPENGENI_GITHUB_APP_ID: settings.githubAppId,
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
    // Required for the authenticated-user membership endpoint that proves an
    // active organization owner. Existing installations must approve this
    // permission before organization-owner self-service can succeed.
    members: "read",
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
    // A setup URL and OAuth-on-install are mutually exclusive in GitHub's App
    // contract. OpenGeni needs the setup callback to receive the installation
    // id, then starts its own exact user-authorization flow.
    request_oauth_on_install: !input.setupUrl,
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
 * and repositories the user can explicitly access. This is compatibility
 * discovery metadata only: visibility and repository permission bits do not
 * prove that the human may install, configure, or bind the App installation.
 * No production binding path may treat this result as authority.
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

/**
 * Prove current GitHub installation authority without treating repository
 * administration or installation visibility as delegation authority.
 *
 * GitHub exposes an exact personal-account owner through the authenticated
 * user's immutable id. For organizations, GitHub's authenticated membership
 * endpoint exposes active owners as role=admin. GitHub does not expose an
 * equivalent current-authority receipt for App Managers, so that case remains
 * unsupported and fails closed.
 */
export async function authorizeGitHubInstallationBinding(
  settings: Settings,
  input: { code: string; installationId: number },
): Promise<GitHubInstallationBindingProof> {
  const userToken = await exchangeGitHubOAuthCodeForUserToken(settings, input.code);
  const actor = await getAuthenticatedGitHubUser(userToken);
  const visibleInstallations = await listUserAccessibleInstallations(userToken);
  const visible = visibleInstallations.find(
    (installation) => installation.installationId === input.installationId,
  );
  if (!visible) {
    throw new GitHubInstallationAuthorityError(
      "authority_denied",
      "GitHub did not associate this installation with the authorized user",
    );
  }

  const jwt = await createGitHubAppJwt(settings);
  const livePayload = (await listInstallations(jwt)).find(
    (installation) => asInt(installation.id) === input.installationId,
  );
  if (!livePayload) {
    throw new GitHubInstallationAuthorityError(
      "installation_missing",
      "GitHub App installation was deleted or is not owned by this App",
    );
  }
  const installation = installationSummaryFromPayload(livePayload);
  if (
    installation.accountId !== visible.accountId ||
    installation.accountLogin !== visible.accountLogin ||
    installation.accountType !== visible.accountType
  ) {
    throw new GitHubInstallationAuthorityError(
      "authority_denied",
      "GitHub installation identity changed during authorization",
    );
  }
  if (installation.suspended) {
    throw new GitHubInstallationAuthorityError(
      "installation_suspended",
      "GitHub App installation is suspended",
    );
  }

  let authorityKind: GitHubInstallationBindingProof["authorityKind"];
  if (installation.accountType === "User" && actor.id === installation.accountId) {
    authorityKind = "personal_owner";
  } else if (installation.accountType === "Organization" && installation.accountLogin) {
    await assertActiveOrganizationOwner(
      userToken,
      installation.accountId,
      installation.accountLogin,
    );
    authorityKind = "organization_owner";
  } else {
    throw new GitHubInstallationAuthorityError(
      "authority_denied",
      "Only a GitHub personal-account owner or organization owner may bind an installation",
    );
  }

  const installationToken = await createInstallationToken(jwt, {
    installationId: installation.installationId,
  });
  const repositories = await listInstallationRepositories(
    installationToken.token,
    installation.installationId,
    { login: installation.accountLogin, type: installation.accountType },
  );
  if (repositories.length === 0) {
    throw new GitHubInstallationAuthorityError(
      "repository_access_empty",
      "GitHub App installation does not currently grant access to any repositories",
    );
  }
  if (authorityKind === "organization_owner") {
    // Repository enumeration is an async provider boundary. Re-read the live
    // owner tuple after it so a role revoked after the chooser proof cannot be
    // durably bound with a later, misleading authority timestamp.
    await assertActiveOrganizationOwner(
      userToken,
      installation.accountId,
      installation.accountLogin!,
    );
  }
  return {
    actorId: actor.id,
    actorLogin: actor.login,
    authorityKind,
    installation,
    repositories,
  };
}

/**
 * Discover existing installations that the freshly authorized GitHub human
 * can bind as an exact personal owner or active organization owner.
 *
 * `GET /user/installations` is discovery input only. Every candidate is
 * cross-checked against the App's live installation inventory and an
 * organization candidate requires a live `state=active, role=admin`
 * membership proof. The later exact authorization still re-runs the complete
 * proof immediately before the durable bind.
 */
export async function discoverGitHubInstallationBindingCandidates(
  settings: Settings,
  input: { code: string },
): Promise<GitHubInstallationBindingCandidate[]> {
  const userToken = await exchangeGitHubOAuthCodeForUserToken(settings, input.code);
  const actor = await getAuthenticatedGitHubUser(userToken);
  const visibleInstallations = await listUserAccessibleInstallations(userToken);
  const jwt = await createGitHubAppJwt(settings);
  const liveInstallations = new Map(
    (await listInstallations(jwt)).map((payload) => {
      const installation = installationSummaryFromPayload(payload);
      return [installation.installationId, installation] as const;
    }),
  );
  const candidates: GitHubInstallationBindingCandidate[] = [];

  for (const visible of visibleInstallations) {
    const installation = liveInstallations.get(visible.installationId);
    if (
      !installation ||
      installation.suspended ||
      installation.accountId !== visible.accountId ||
      installation.accountLogin !== visible.accountLogin ||
      installation.accountType !== visible.accountType
    ) {
      continue;
    }
    if (installation.accountType === "User" && actor.id === installation.accountId) {
      candidates.push({ installation, authorityKind: "personal_owner" });
      continue;
    }
    if (installation.accountType !== "Organization" || !installation.accountLogin) {
      continue;
    }
    try {
      await assertActiveOrganizationOwner(
        userToken,
        installation.accountId,
        installation.accountLogin,
      );
      candidates.push({ installation, authorityKind: "organization_owner" });
    } catch (error) {
      if (
        error instanceof GitHubInstallationAuthorityError &&
        error.reason === "authority_unavailable"
      ) {
        continue;
      }
      if (
        error instanceof GitHubInstallationAuthorityError &&
        error.reason === "authority_denied"
      ) {
        continue;
      }
      throw error;
    }
  }

  return candidates.sort((left, right) =>
    (left.installation.accountLogin ?? "").localeCompare(right.installation.accountLogin ?? ""),
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
  return await listGitHubAppRepositoriesWithSigningSettings(settings, input);
}

/** List repositories for a separately registered App that needs only signing credentials. */
export async function listGitHubAppRepositoriesWithSigningSettings(
  settings: GitHubAppSigningSettings,
  input: {
    installationIds?: number[];
  } = {},
): Promise<GitHubRepository[]> {
  const missing = githubAppTokenMissingSettings(settings);
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

export type GitHubAppInstallationRepositoryLookupInput = {
  installationId: number;
  owner: string;
  name: string;
};

export type GitHubAppInstallationRepositoryLookup = (
  input: GitHubAppInstallationRepositoryLookupInput,
) => Promise<GitHubRepository | null>;

/**
 * Resolve one `owner/name` repository through an exact App installation and
 * return GitHub's stable repository identity, or null when that installation
 * cannot see the repository. The server-side lookup token never leaves the
 * caller and grants nothing by itself: the workspace allowlist decides whether
 * the returned id may mint a sandbox-bound token.
 */
export async function getGitHubAppInstallationRepository(
  settings: Settings,
  input: GitHubAppInstallationRepositoryLookupInput,
): Promise<GitHubRepository | null> {
  return await createGitHubAppInstallationRepositoryLookup(settings)(input);
}

/**
 * One lookup client that reuses a server-side installation token per
 * installation for its lifetime (one worker turn), so several bare repository
 * URIs from the same installation cost one mint plus one read each.
 */
export function createGitHubAppInstallationRepositoryLookup(
  settings: Settings,
): GitHubAppInstallationRepositoryLookup {
  const missing = githubAppMissingSettings(settings);
  if (missing.length > 0) {
    throw new GitHubAppConfigurationError(missing);
  }
  const tokens = new Map<number, Promise<GitHubAppInstallationToken>>();
  const installationToken = (installationId: number): Promise<GitHubAppInstallationToken> => {
    let pending = tokens.get(installationId);
    if (!pending) {
      // Metadata-read only: the lookup needs the repository id, never contents.
      // Bounded well below the sandbox mint timeout so a slow GitHub cannot
      // hold turn start; the caller proceeds bare on expiry.
      pending = createGitHubAppJwt(settings).then((jwt) =>
        createInstallationToken(jwt, {
          installationId,
          permissions: { metadata: "read" },
          timeoutMs: githubRepositoryLookupTimeoutMs,
        }),
      );
      pending.catch(() => tokens.delete(installationId));
      tokens.set(installationId, pending);
    }
    return pending;
  };
  return async (input) => {
    const owner = input.owner.trim();
    const name = input.name.trim();
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(owner) ||
      !/^[A-Za-z0-9._-]+$/u.test(name)
    ) {
      return null;
    }
    const token = await installationToken(input.installationId);
    const response = await fetch(
      `${githubApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        headers: githubHeaders(token.token),
        signal: AbortSignal.timeout(githubRepositoryLookupTimeoutMs),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new GitHubAppApiError(await githubErrorMessage(response), response.status);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new GitHubAppApiError("GitHub returned an invalid repository payload");
    }
    const record = payload as Record<string, unknown>;
    const account =
      record.owner && typeof record.owner === "object" && !Array.isArray(record.owner)
        ? (record.owner as Record<string, unknown>)
        : {};
    return repositoryFromPayload(record, input.installationId, account);
  };
}

/**
 * List one bounded page of branch suggestions with an exact repository-scoped
 * installation token. The token remains local to this server-side helper and
 * is never returned in repository or branch metadata.
 */
export async function listGitHubAppRepositoryBranches(
  settings: Settings,
  input: {
    installationId: number;
    repositoryId: number;
    page: number;
    limit: number;
  },
): Promise<GitHubAppRepositoryBranchPage> {
  if (
    !Number.isSafeInteger(input.installationId) ||
    input.installationId <= 0 ||
    !Number.isSafeInteger(input.repositoryId) ||
    input.repositoryId <= 0 ||
    !Number.isSafeInteger(input.page) ||
    input.page <= 0 ||
    input.page > 10_000 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > 100
  ) {
    throw new GitHubAppApiError("GitHub branch lookup requires bounded exact repository input");
  }
  const minted = await createGitHubAppInstallationTokenWithSigningSettings(settings, {
    installationId: input.installationId,
    repositoryIds: [input.repositoryId],
    permissions: { contents: "read", metadata: "read" },
    timeoutMs: githubRepositoryBranchesTimeoutMs,
  });
  const repositoryResponse = await githubRepositoryBranchesFetch(
    new URL(`${githubApiBase}/repositories/${input.repositoryId}`),
    minted.token,
    "GitHub repository branch identity",
  );
  const repositoryPayload = await githubResponseJsonBounded(
    repositoryResponse,
    "GitHub repository branch identity response",
  );
  if (
    !repositoryPayload ||
    typeof repositoryPayload !== "object" ||
    Array.isArray(repositoryPayload)
  ) {
    throw new GitHubAppApiError("GitHub returned an invalid repository branch identity payload");
  }
  const repository = repositoryPayload as Record<string, unknown>;
  const repositoryId = asInt(repository.id);
  const fullName = typeof repository.full_name === "string" ? repository.full_name : "";
  const defaultBranch =
    typeof repository.default_branch === "string" ? repository.default_branch : "";
  const coordinates = fullName.split("/");
  if (
    repositoryId !== input.repositoryId ||
    coordinates.length !== 2 ||
    !coordinates[0] ||
    !coordinates[1] ||
    defaultBranch.length === 0 ||
    defaultBranch.length > 1024
  ) {
    throw new GitHubAppApiError("GitHub returned an invalid repository branch identity payload");
  }
  const branchUrl = new URL(
    `${githubApiBase}/repos/${encodeURIComponent(coordinates[0])}/${encodeURIComponent(coordinates[1])}/branches`,
  );
  branchUrl.searchParams.set("page", String(input.page));
  branchUrl.searchParams.set("per_page", String(input.limit));
  const branchesResponse = await githubRepositoryBranchesFetch(
    branchUrl,
    minted.token,
    "GitHub repository branches",
  );
  const branchPayload = await githubResponseJsonBounded(
    branchesResponse,
    "GitHub repository branches response",
  );
  if (!Array.isArray(branchPayload) || branchPayload.length > input.limit) {
    throw new GitHubAppApiError("GitHub returned an invalid repository branches payload");
  }
  const branches: string[] = [];
  const seen = new Set<string>();
  for (const value of branchPayload) {
    const name =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).name
        : null;
    if (typeof name !== "string" || name.length === 0 || name.length > 1024 || seen.has(name)) {
      throw new GitHubAppApiError("GitHub returned an invalid repository branches payload");
    }
    seen.add(name);
    branches.push(name);
  }
  return {
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    defaultBranch,
    branches,
    nextPage: branchPayload.length === input.limit && input.page < 10_000 ? input.page + 1 : null,
  };
}

export async function createGitHubAppInstallationToken(
  settings: Settings,
  input: {
    installationId: number;
    repositoryIds: number[];
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
    repositoryIds: number[];
  },
): Promise<GitHubAppInstallationToken> {
  const missing = githubAppMissingSettings(settings);
  if (missing.length > 0) {
    throw new GitHubAppConfigurationError(missing);
  }
  return await createGitHubAppInstallationTokenWithSigningSettings(settings, input);
}

/** Mint for a separately registered App without requiring unrelated OAuth settings. */
export async function createGitHubAppInstallationTokenWithSigningSettings(
  settings: GitHubAppSigningSettings,
  input: {
    installationId: number;
    repositoryIds: number[];
    permissions?: Record<string, "read" | "write">;
    timeoutMs?: number;
  },
): Promise<GitHubAppInstallationToken> {
  const missing = githubAppTokenMissingSettings(settings);
  if (missing.length > 0) {
    throw new GitHubAppConfigurationError(missing);
  }
  if (!Array.isArray(input.repositoryIds)) {
    throw new GitHubAppApiError(
      "GitHub installation token mint requires an explicit, unique repository allowlist",
    );
  }
  const repositoryIds = [...new Set(input.repositoryIds)];
  if (
    !Number.isSafeInteger(input.installationId) ||
    input.installationId <= 0 ||
    repositoryIds.length === 0 ||
    repositoryIds.length !== input.repositoryIds.length ||
    repositoryIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new GitHubAppApiError(
      "GitHub installation token mint requires an explicit, unique repository allowlist",
    );
  }
  const jwt = await createGitHubAppJwt(settings);
  return await createInstallationToken(jwt, {
    installationId: input.installationId,
    repositoryIds,
    ...(input.permissions ? { permissions: input.permissions } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
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

export const GITHUB_APP_BOT_IDENTITY_UNAVAILABLE_WARNING =
  "github_app_bot_identity_unavailable" as const;

/**
 * Non-secret health posture for the stable sandbox Git identity. API-direct
 * attach and worker-turn startup must add the same identity keys. A complete
 * deployment-level author identity is sufficient because committer values
 * default to it; otherwise a partially configured workspace GitHub App must
 * surface that its bot identity cannot be derived.
 */
export function githubAppBotIdentityWarnings(
  settings: Settings,
): Array<typeof GITHUB_APP_BOT_IDENTITY_UNAVAILABLE_WARNING> {
  const workspaceAppConfigured = [
    settings.githubAppId,
    settings.githubClientId,
    settings.githubClientSecret,
    settings.githubAppSlug,
    settings.githubWebhookSecret,
    settings.githubAppPrivateKey,
  ].some((value) => typeof value === "string" && value.trim().length > 0);
  const explicitGitIdentityConfigured =
    typeof settings.gitAuthorName === "string" &&
    settings.gitAuthorName.trim().length > 0 &&
    typeof settings.gitAuthorEmail === "string" &&
    settings.gitAuthorEmail.trim().length > 0;
  if (
    !workspaceAppConfigured ||
    explicitGitIdentityConfigured ||
    githubAppBotIdentity(settings) !== null
  ) {
    return [];
  }
  return [GITHUB_APP_BOT_IDENTITY_UNAVAILABLE_WARNING];
}

async function createGitHubAppJwt(settings: GitHubAppSigningSettings): Promise<string> {
  const privateKey = normalizeGitHubAppPrivateKey(settings.githubAppPrivateKey ?? "");
  const appId = settings.githubAppId?.trim();
  if (!appId || !privateKey) {
    throw new GitHubAppConfigurationError(githubAppTokenMissingSettings(settings));
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

async function getAuthenticatedGitHubUser(token: string): Promise<{ id: number; login: string }> {
  const payload = await githubGet("/user", token);
  const id = payload && typeof payload === "object" ? asInt(payload.id) : null;
  const login =
    payload && typeof payload === "object" && typeof payload.login === "string"
      ? payload.login
      : null;
  if (id === null || !login) {
    throw new GitHubAppApiError("GitHub returned an invalid authenticated user payload");
  }
  return { id, login };
}

async function getAuthenticatedOrganizationMembership(
  token: string,
  organizationLogin: string,
): Promise<{ organizationId: number; role: string; state: string }> {
  let payload: any;
  try {
    payload = await githubGet(
      `/user/memberships/orgs/${encodeURIComponent(organizationLogin)}`,
      token,
    );
  } catch (error) {
    if (error instanceof GitHubAppApiError) {
      throw new GitHubInstallationAuthorityError(
        "authority_unavailable",
        "GitHub could not prove current organization-owner membership",
        error.status,
      );
    }
    throw error;
  }
  const organization =
    payload && typeof payload === "object" && payload.organization ? payload.organization : null;
  const organizationId =
    organization && typeof organization === "object" ? asInt(organization.id) : null;
  if (
    organizationId === null ||
    typeof payload?.role !== "string" ||
    typeof payload?.state !== "string"
  ) {
    throw new GitHubInstallationAuthorityError(
      "authority_unavailable",
      "GitHub returned an invalid organization membership proof",
    );
  }
  return { organizationId, role: payload.role, state: payload.state };
}

async function assertActiveOrganizationOwner(
  token: string,
  organizationId: number,
  organizationLogin: string,
): Promise<void> {
  const membership = await getAuthenticatedOrganizationMembership(token, organizationLogin);
  if (
    membership.organizationId !== organizationId ||
    membership.state !== "active" ||
    membership.role !== "admin"
  ) {
    throw new GitHubInstallationAuthorityError(
      "authority_denied",
      "Only an active GitHub organization owner may bind this installation",
    );
  }
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
    /** Narrow the token below the installation's granted permissions. */
    permissions?: Record<string, "read" | "write">;
    timeoutMs?: number;
  },
): Promise<GitHubAppInstallationToken> {
  const body: Record<string, unknown> = {};
  if (input.repositoryIds && input.repositoryIds.length > 0) {
    body.repository_ids = input.repositoryIds;
  }
  if (input.permissions && Object.keys(input.permissions).length > 0) {
    body.permissions = input.permissions;
  }
  const scoped = Object.keys(body).length > 0;
  const response = await fetch(
    `${githubApiBase}/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(appJwt),
        ...(scoped ? { "Content-Type": "application/json" } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? githubTokenMintTimeoutMs),
      ...(scoped ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (!response.ok) {
    throw new GitHubAppApiError(await githubErrorMessage(response), response.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(
      await readResponseTextBounded(
        response,
        githubInstallationTokenResponseMaxBytes,
        "GitHub installation token response",
      ),
    ) as unknown;
  } catch {
    throw new GitHubAppApiError("GitHub returned an invalid installation token payload");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GitHubAppApiError("GitHub returned an invalid installation token payload");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.token !== "string") {
    throw new GitHubAppApiError("GitHub returned an invalid installation token payload");
  }
  return {
    token: record.token,
    expiresAt: typeof record.expires_at === "string" ? record.expires_at : null,
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
  const accountId = asInt(account.id);
  if (accountId === null) {
    throw new GitHubAppApiError("GitHub returned an installation without an account id");
  }
  return {
    installationId,
    accountId,
    accountLogin: typeof account.login === "string" ? account.login : null,
    accountType: typeof account.type === "string" ? account.type : null,
    suspended: Boolean(payload.suspended_at),
  };
}

async function githubGet(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<any> {
  const url = new URL(`${githubApiBase}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    throw new GitHubAppApiError(await githubErrorMessage(response), response.status);
  }
  return await response.json();
}

async function githubRepositoryBranchesFetch(
  url: URL,
  token: string,
  label: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: githubHeaders(token),
      redirect: "manual",
      signal: AbortSignal.timeout(githubRepositoryBranchesTimeoutMs),
    });
  } catch {
    throw new GitHubAppApiError(`${label} request failed`);
  }
  if (!response.ok) {
    throw new GitHubAppApiError(await githubErrorMessage(response), response.status);
  }
  return response;
}

async function githubResponseJsonBounded(response: Response, label: string): Promise<unknown> {
  try {
    return JSON.parse(
      await readResponseTextBounded(response, githubRepositoryBranchesResponseMaxBytes, label),
    ) as unknown;
  } catch {
    throw new GitHubAppApiError(`${label} was invalid or too large`);
  }
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
  let text: string;
  try {
    text = await readResponseTextBounded(
      response,
      githubErrorResponseMaxBytes,
      "GitHub error response",
    );
  } catch {
    return `GitHub API ${response.status}`;
  }
  try {
    const payload = JSON.parse(text) as unknown;
    if (payload && typeof payload === "object" && "message" in payload) {
      return `GitHub API ${response.status}: ${String(
        (payload as Record<string, unknown>).message,
      ).slice(0, githubErrorMessageMaxLength)}`;
    }
  } catch {
    // Fall through to the bounded text body.
  }
  return `GitHub API ${response.status}: ${text.slice(0, githubErrorMessageMaxLength)}`;
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
