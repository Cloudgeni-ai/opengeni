import {
  PERSONAL_GITHUB_API_ORIGIN,
  PERSONAL_GITHUB_PROVIDER_DOMAIN,
  PERSONAL_GITHUB_REPOSITORY_CATALOG_MAX,
  PersonalGitHubRepository,
  canonicalPersonalGitHubRepositoryUrl,
  isPersonalGitHubConnection,
  type PersonalGitHubRepository as PersonalGitHubRepositoryContract,
  type PersonalGitHubRepositorySelectionInput,
} from "@opengeni/contracts/personal-github";
import {
  GitHubRepositoryBranchesResponse,
  type GitHubRepositoryBranchesResponse as GitHubRepositoryBranchesResponseContract,
  type ListGitHubRepositoryBranchesQuery,
} from "@opengeni/contracts/github-repository-contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  getConnectionMetadata,
  getPersonalGitHubRepositorySelectionState,
  type PersonalGitHubRepositorySelectionState as DbPersonalGitHubRepositorySelectionState,
} from "@opengeni/db";
import { readResponseTextBounded } from "@opengeni/network";
import { HTTPException } from "hono/http-exception";
import JSONBig from "json-bigint";

const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_REPOSITORIES_RESPONSE_MAX_BYTES = 1024 * 1024;
const GITHUB_BRANCHES_RESPONSE_MAX_BYTES = 256 * 1024;
const personalGitHubProviderJsonParser = JSONBig({
  storeAsString: true,
  protoAction: "error",
  constructorAction: "error",
});

export type PersonalGitHubRepositoryConnection = NonNullable<
  Awaited<ReturnType<typeof getConnectionMetadata>>
>;

type PersonalGitHubRepositoryProviderOperation =
  | "repositories_list"
  | "repository_branches_list"
  | "repository_verify";

type ExpectedPersonalGitHubRepositoryAuthority = {
  selectionGeneration: number;
  repositoryId: string;
  fullName: string;
};

type PersonalGitHubProviderJsonOptions = {
  operation: PersonalGitHubRepositoryProviderOperation;
  expectedRepositoryAuthority?: ExpectedPersonalGitHubRepositoryAuthority;
  responseLabel?: string;
  responseMaxBytes?: number;
};

export type PersonalGitHubRepositoryBranchServices = {
  requireConnection: typeof requirePersonalGitHubRepositoryConnection;
  getSelectionState: (
    deps: ApiRouteDeps,
    input: {
      accountId: string;
      originWorkspaceId: string;
      subjectId: string;
      connectionId: string;
    },
  ) => Promise<DbPersonalGitHubRepositorySelectionState | null>;
  providerJson: (input: {
    deps: ApiRouteDeps;
    connection: PersonalGitHubRepositoryConnection;
    subjectId: string;
    url: URL;
    expectedConnectionAuthorityGeneration: number;
    options: PersonalGitHubProviderJsonOptions;
  }) => Promise<unknown>;
};

const personalGitHubRepositoryBranchServices: PersonalGitHubRepositoryBranchServices = {
  requireConnection: requirePersonalGitHubRepositoryConnection,
  getSelectionState: async (deps, input) =>
    await getPersonalGitHubRepositorySelectionState(deps.db, input),
  providerJson: async (input) =>
    await personalGitHubProviderJson(
      input.deps,
      input.connection,
      input.subjectId,
      input.url,
      input.expectedConnectionAuthorityGeneration,
      input.options,
    ),
};

export type PersonalGitHubRepositoryProviderErrorCode =
  | "connection_changed"
  | "connection_inactive"
  | "invalid_provider_response"
  | "provider_denied"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "repository_archived"
  | "repository_not_found"
  | "repository_not_selected"
  | "repository_read_denied"
  | "repository_selection_changed"
  | "repository_write_denied";

export class PersonalGitHubRepositoryProviderError extends Error {
  constructor(readonly code: PersonalGitHubRepositoryProviderErrorCode) {
    super(code);
    this.name = "PersonalGitHubRepositoryProviderError";
  }
}

export async function requirePersonalGitHubRepositoryConnection(
  deps: ApiRouteDeps,
  input: { accountId: string; workspaceId: string; subjectId: string; connectionId: string },
): Promise<PersonalGitHubRepositoryConnection> {
  if (!deps.settings.githubPersonalOauthEnabled) {
    throw new HTTPException(404, {
      message: "personal GitHub repository discovery is not enabled",
    });
  }
  const connection = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (
    !connection ||
    connection.accountId !== input.accountId ||
    connection.subjectId !== input.subjectId ||
    !isPersonalGitHubConnection(connection)
  ) {
    throw new HTTPException(404, { message: "personal GitHub connection not found" });
  }
  if (connection.status !== "active") {
    throw new HTTPException(409, { message: "personal GitHub connection must be reconnected" });
  }
  return connection;
}

export async function listLivePersonalGitHubRepositories(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    accountId: string;
    subjectId: string;
    connectionId: string;
    expectedConnectionAuthorityGeneration: number;
    page: number;
    limit: number;
  },
): Promise<{ repositories: PersonalGitHubRepositoryContract[]; nextPage: number | null }> {
  const connection = await requirePersonalGitHubRepositoryConnection(deps, input);
  const url = new URL("/user/repos", PERSONAL_GITHUB_API_ORIGIN);
  url.searchParams.set("affiliation", "owner,collaborator,organization_member");
  url.searchParams.set("direction", "asc");
  url.searchParams.set("page", String(input.page));
  url.searchParams.set("per_page", String(input.limit));
  url.searchParams.set("sort", "full_name");
  const payload = await personalGitHubProviderJson(
    deps,
    connection,
    input.subjectId,
    url,
    input.expectedConnectionAuthorityGeneration,
    { operation: "repositories_list" },
  );
  if (!Array.isArray(payload) || payload.length > PERSONAL_GITHUB_REPOSITORY_CATALOG_MAX) {
    throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
  }
  const repositories: PersonalGitHubRepositoryContract[] = [];
  const seen = new Set<string>();
  for (const value of payload) {
    const repository = parsePersonalGitHubRepository(value);
    if (seen.has(repository.repositoryId)) {
      throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
    }
    seen.add(repository.repositoryId);
    if (personalGitHubRepositoryCanRead(repository.permissions)) repositories.push(repository);
  }
  return {
    repositories,
    nextPage: payload.length === input.limit && input.page < 10_000 ? input.page + 1 : null,
  };
}

export async function listLivePersonalGitHubRepositoryBranches(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    accountId: string;
    subjectId: string;
    connectionId: string;
    repositoryId: string;
    query: ListGitHubRepositoryBranchesQuery;
  },
  services: PersonalGitHubRepositoryBranchServices = personalGitHubRepositoryBranchServices,
): Promise<GitHubRepositoryBranchesResponseContract> {
  const connection = await services.requireConnection(deps, input);
  const current = await requireSelectedPersonalGitHubRepository(
    deps,
    connection,
    input,
    null,
    services.getSelectionState,
  );
  const [owner, repositoryName] = current.repository.fullName.split("/");
  if (!owner || !repositoryName) {
    throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
  }
  const url = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/branches`,
    PERSONAL_GITHUB_API_ORIGIN,
  );
  url.searchParams.set("page", String(input.query.cursor));
  url.searchParams.set("per_page", String(input.query.limit));
  const expectedRepositoryAuthority = {
    selectionGeneration: current.selectionGeneration,
    repositoryId: current.repository.repositoryId,
    fullName: current.repository.fullName,
  };
  const payload = await services.providerJson({
    deps,
    connection,
    subjectId: input.subjectId,
    url,
    expectedConnectionAuthorityGeneration: current.connectionAuthorityGeneration,
    options: {
      operation: "repository_branches_list",
      expectedRepositoryAuthority,
      responseLabel: "GitHub repository branches response",
      responseMaxBytes: GITHUB_BRANCHES_RESPONSE_MAX_BYTES,
    },
  });
  if (!Array.isArray(payload) || payload.length > input.query.limit) {
    throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
  }
  const branches: string[] = [];
  const seen = new Set<string>();
  for (const value of payload) {
    const name =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).name
        : null;
    if (typeof name !== "string" || name.length === 0 || name.length > 1024 || seen.has(name)) {
      throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
    }
    seen.add(name);
    branches.push(name);
  }
  await requireSelectedPersonalGitHubRepository(
    deps,
    connection,
    input,
    expectedRepositoryAuthority,
    services.getSelectionState,
  );
  const response = GitHubRepositoryBranchesResponse.safeParse({
    branches: branches.map((name) => ({
      name,
      isDefault: name === current.repository.defaultBranch,
    })),
    nextCursor:
      branches.length === input.query.limit && input.query.cursor < 10_000
        ? input.query.cursor + 1
        : null,
  });
  if (!response.success) {
    throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
  }
  return response.data;
}

/** Serial by design: one bounded provider request and one authority check at a time. */
export async function verifyLivePersonalGitHubRepositories(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    accountId: string;
    subjectId: string;
    connectionId: string;
    expectedConnectionAuthorityGeneration: number;
    repositories: PersonalGitHubRepositorySelectionInput[];
  },
): Promise<Array<PersonalGitHubRepositoryContract & { selectedAccess: "read" | "write" }>> {
  const connection = await requirePersonalGitHubRepositoryConnection(deps, input);
  const verified: Array<PersonalGitHubRepositoryContract & { selectedAccess: "read" | "write" }> =
    [];
  for (const selection of input.repositories) {
    const [owner, repositoryName] = selection.fullName.split("/");
    if (!owner || !repositoryName) {
      throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
    }
    const url = new URL(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`,
      PERSONAL_GITHUB_API_ORIGIN,
    );
    const payload = await personalGitHubProviderJson(
      deps,
      connection,
      input.subjectId,
      url,
      input.expectedConnectionAuthorityGeneration,
      { operation: "repository_verify" },
    );
    const repository = parsePersonalGitHubRepository(payload);
    if (
      repository.repositoryId !== selection.repositoryId ||
      repository.fullName.toLowerCase() !== selection.fullName.toLowerCase()
    ) {
      throw new PersonalGitHubRepositoryProviderError("repository_not_found");
    }
    if (!personalGitHubRepositoryCanRead(repository.permissions)) {
      throw new PersonalGitHubRepositoryProviderError("repository_read_denied");
    }
    if (selection.access === "write") {
      if (repository.archived || repository.disabled) {
        throw new PersonalGitHubRepositoryProviderError("repository_archived");
      }
      if (!personalGitHubRepositoryCanWrite(repository.permissions)) {
        throw new PersonalGitHubRepositoryProviderError("repository_write_denied");
      }
    }
    verified.push({ ...repository, selectedAccess: selection.access });
  }
  return verified;
}

async function requireSelectedPersonalGitHubRepository(
  deps: ApiRouteDeps,
  connection: PersonalGitHubRepositoryConnection,
  input: {
    accountId: string;
    subjectId: string;
    connectionId: string;
    repositoryId: string;
  },
  expected: ExpectedPersonalGitHubRepositoryAuthority | null,
  getSelectionState: PersonalGitHubRepositoryBranchServices["getSelectionState"],
): Promise<{
  connectionAuthorityGeneration: number;
  selectionGeneration: number;
  repository: NonNullable<
    Awaited<ReturnType<typeof getPersonalGitHubRepositorySelectionState>>
  >["repositories"][number];
}> {
  const selection = await getSelectionState(deps, {
    accountId: input.accountId,
    originWorkspaceId: connection.workspaceId,
    subjectId: input.subjectId,
    connectionId: input.connectionId,
  });
  if (!selection) {
    throw new PersonalGitHubRepositoryProviderError(
      expected ? "repository_selection_changed" : "repository_not_selected",
    );
  }
  const repository = selection.repositories.find(
    (candidate) => candidate.repositoryId === input.repositoryId,
  );
  if (!repository) {
    throw new PersonalGitHubRepositoryProviderError(
      expected ? "repository_selection_changed" : "repository_not_selected",
    );
  }
  if (
    expected &&
    (selection.selectionGeneration !== expected.selectionGeneration ||
      repository.repositoryId !== expected.repositoryId ||
      repository.fullName !== expected.fullName)
  ) {
    throw new PersonalGitHubRepositoryProviderError("repository_selection_changed");
  }
  return {
    connectionAuthorityGeneration: selection.connectionAuthorityGeneration,
    selectionGeneration: selection.selectionGeneration,
    repository,
  };
}

export function personalGitHubRepositoryProviderHttpError(
  error: PersonalGitHubRepositoryProviderError,
): HTTPException {
  switch (error.code) {
    case "connection_changed":
      return new HTTPException(409, {
        message: "personal GitHub connection changed; refresh and try again",
      });
    case "connection_inactive":
    case "provider_denied":
      return new HTTPException(401, { message: "personal GitHub must be reconnected" });
    case "provider_rate_limited":
      return new HTTPException(503, { message: "GitHub is temporarily rate limited" });
    case "repository_not_found":
      return new HTTPException(422, { message: "a selected GitHub repository is unavailable" });
    case "repository_not_selected":
      return new HTTPException(404, {
        message: "personal GitHub repository is not selected for this connection",
      });
    case "repository_selection_changed":
      return new HTTPException(409, {
        message: "personal GitHub repository selection changed; refresh and try again",
      });
    case "repository_archived":
      return new HTTPException(422, {
        message: "an archived or disabled GitHub repository cannot be selected for write access",
      });
    case "repository_read_denied":
      return new HTTPException(422, {
        message: "a selected GitHub repository is not readable",
      });
    case "repository_write_denied":
      return new HTTPException(422, {
        message: "a selected GitHub repository does not allow writes",
      });
    case "invalid_provider_response":
    case "provider_unavailable":
      return new HTTPException(502, { message: "GitHub repository discovery is unavailable" });
  }
}

async function personalGitHubProviderJson(
  deps: ApiRouteDeps,
  connection: PersonalGitHubRepositoryConnection,
  subjectId: string,
  url: URL,
  expectedConnectionAuthorityGeneration: number,
  options: PersonalGitHubProviderJsonOptions,
): Promise<unknown> {
  if (url.origin !== PERSONAL_GITHUB_API_ORIGIN) {
    throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
  }
  let response = await personalGitHubProviderFetch(
    deps,
    connection,
    subjectId,
    url,
    expectedConnectionAuthorityGeneration,
    options.operation,
    options.expectedRepositoryAuthority,
    false,
  );
  if (response.status === 401) {
    await cancelResponse(response);
    response = await personalGitHubProviderFetch(
      deps,
      connection,
      subjectId,
      url,
      expectedConnectionAuthorityGeneration,
      options.operation,
      options.expectedRepositoryAuthority,
      true,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    await cancelResponse(response);
    throw new PersonalGitHubRepositoryProviderError("provider_unavailable");
  }
  if (!response.ok) {
    const status = response.status;
    const rateLimited =
      status === 429 ||
      (status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after")));
    await cancelResponse(response);
    if (status === 401 || status === 403) {
      throw new PersonalGitHubRepositoryProviderError(
        rateLimited ? "provider_rate_limited" : "provider_denied",
      );
    }
    if (status === 429) {
      throw new PersonalGitHubRepositoryProviderError("provider_rate_limited");
    }
    if (status === 404 && options.operation !== "repositories_list") {
      throw new PersonalGitHubRepositoryProviderError("repository_not_found");
    }
    throw new PersonalGitHubRepositoryProviderError("provider_unavailable");
  }
  try {
    return parsePersonalGitHubProviderJson(
      await readResponseTextBounded(
        response,
        options.responseMaxBytes ?? GITHUB_REPOSITORIES_RESPONSE_MAX_BYTES,
        options.responseLabel ??
          (options.operation === "repositories_list"
            ? "GitHub repositories response"
            : "GitHub repository response"),
      ),
    );
  } catch {
    throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
  }
}

/** Keep provider integer lexemes exact before repository IDs become bigint-backed strings. */
export function parsePersonalGitHubProviderJson(value: string): unknown {
  return personalGitHubProviderJsonParser.parse(value) as unknown;
}

async function personalGitHubProviderFetch(
  deps: ApiRouteDeps,
  connection: PersonalGitHubRepositoryConnection,
  subjectId: string,
  url: URL,
  expectedConnectionAuthorityGeneration: number,
  operation: PersonalGitHubRepositoryProviderOperation,
  expectedRepositoryAuthority: ExpectedPersonalGitHubRepositoryAuthority | undefined,
  forceRefresh: boolean,
): Promise<Response> {
  const resolver = buildConnectionTokenResolver(deps.db, deps.settings, undefined, {
    ...(deps.githubPersonalFetch
      ? { refreshTransport: { fetchImpl: deps.githubPersonalFetch } }
      : {}),
  });
  const credential = await resolver({
    workspaceId: connection.workspaceId,
    subjectId,
    serverId: "github-personal-repository-picker",
    toolName: operation,
    connectionRef: {
      connectionId: connection.id,
      providerDomain: PERSONAL_GITHUB_PROVIDER_DOMAIN,
      kind: "oauth2",
      subjectScope: "subject",
      scopes: ["repo"],
    },
    destinationUrl: url.toString(),
    credentialTarget: "http_api",
    forceRefresh,
  });
  if (credential.status !== "ok") {
    throw new PersonalGitHubRepositoryProviderError("connection_inactive");
  }
  if (credential.connectionId !== connection.id || credential.connectionVersion === undefined) {
    throw new PersonalGitHubRepositoryProviderError("connection_changed");
  }
  const current = await getConnectionMetadata(
    deps.db,
    connection.workspaceId,
    connection.id,
    subjectId,
  );
  if (
    !current ||
    current.version !== credential.connectionVersion ||
    current.subjectId !== subjectId ||
    current.status !== "active" ||
    !isPersonalGitHubConnection(current)
  ) {
    throw new PersonalGitHubRepositoryProviderError("connection_changed");
  }
  const authority = await getPersonalGitHubRepositorySelectionState(deps.db, {
    accountId: connection.accountId,
    originWorkspaceId: connection.workspaceId,
    subjectId,
    connectionId: connection.id,
  });
  if (
    !authority ||
    authority.connectionAuthorityGeneration !== expectedConnectionAuthorityGeneration
  ) {
    throw new PersonalGitHubRepositoryProviderError("connection_changed");
  }
  if (expectedRepositoryAuthority) {
    const repository = authority.repositories.find(
      (candidate) => candidate.repositoryId === expectedRepositoryAuthority.repositoryId,
    );
    if (
      authority.selectionGeneration !== expectedRepositoryAuthority.selectionGeneration ||
      !repository ||
      repository.fullName !== expectedRepositoryAuthority.fullName
    ) {
      throw new PersonalGitHubRepositoryProviderError("repository_selection_changed");
    }
  }
  const authorization = Object.entries(credential.headers).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];
  if (!authorization) {
    throw new PersonalGitHubRepositoryProviderError("connection_inactive");
  }
  try {
    return await (deps.githubPersonalFetch ?? fetch)(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        authorization,
        "user-agent": "OpenGeni",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new PersonalGitHubRepositoryProviderError("provider_unavailable");
  }
}

export function personalGitHubRepositoryCanRead(
  permissions: PersonalGitHubRepositoryContract["permissions"],
): boolean {
  return (
    permissions.pull ||
    permissions.triage ||
    permissions.push ||
    permissions.maintain ||
    permissions.admin
  );
}

export function personalGitHubRepositoryCanWrite(
  permissions: PersonalGitHubRepositoryContract["permissions"],
): boolean {
  return permissions.push || permissions.maintain || permissions.admin;
}

export function parsePersonalGitHubRepository(value: unknown): PersonalGitHubRepositoryContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
  }
  const payload = value as Record<string, unknown>;
  const repositoryId = providerRepositoryId(payload.id);
  const fullName = requiredProviderString(payload.full_name, 255);
  const defaultBranch = requiredProviderString(payload.default_branch, 255);
  const permissions = payload.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
  }
  const permissionRecord = permissions as Record<string, unknown>;
  const parsed = PersonalGitHubRepository.safeParse({
    repositoryId,
    fullName,
    canonicalUrl: canonicalPersonalGitHubRepositoryUrl(fullName),
    defaultBranch,
    visibility: payload.visibility,
    private: payload.private,
    archived: payload.archived,
    disabled: payload.disabled,
    permissions: {
      pull: permissionRecord.pull,
      push: permissionRecord.push,
      admin: permissionRecord.admin,
      maintain: permissionRecord.maintain,
      triage: permissionRecord.triage,
    },
  });
  if (!parsed.success) {
    throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
  }
  return parsed.data;
}

function providerRepositoryId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value)) return value;
  throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
}

function requiredProviderString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new PersonalGitHubRepositoryProviderError("invalid_provider_response");
  }
  return value;
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
