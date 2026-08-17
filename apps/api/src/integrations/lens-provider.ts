import type { LensProvider } from "@opengeni/contracts";
import {
  pinnedFetch,
  readResponseJsonBounded,
  readResponseTextBounded,
  type FetchLike,
  type OutboundNetworkSettings,
} from "@opengeni/network";

const providerVerificationTimeoutMs = 15_000;
const providerVerificationResponseMaxBytes = 256 * 1024;
const providerVerificationErrorMaxBytes = 8 * 1024;

export class LensProviderRepositoryError extends Error {
  constructor(
    readonly reason: "denied" | "identity_mismatch" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "LensProviderRepositoryError";
  }
}

export type VerifiedLensProviderRepository = {
  repositoryUri: string;
  repositoryFullName: string;
  providerRepositoryId: string;
  projectId: string;
};

export async function verifyLensProviderRepository(input: {
  provider: Exclude<LensProvider, "github">;
  providerBaseUrl: string;
  providerRepositoryId: string;
  projectId?: string;
  token: string;
  username: string | null;
  settings: OutboundNetworkSettings;
  fetchImpl?: FetchLike;
}): Promise<VerifiedLensProviderRepository> {
  return input.provider === "gitlab"
    ? await verifyGitLabRepository(input)
    : await verifyAzureDevOpsRepository(input);
}

async function verifyGitLabRepository(
  input: Parameters<typeof verifyLensProviderRepository>[0],
): Promise<VerifiedLensProviderRepository> {
  if (!/^\d+$/.test(input.providerRepositoryId)) {
    throw new LensProviderRepositoryError(
      "identity_mismatch",
      "GitLab repository bindings require the numeric project ID",
    );
  }
  const url = providerApiUrl(
    input.providerBaseUrl,
    `api/v4/projects/${encodeURIComponent(input.providerRepositoryId)}`,
  );
  const payload = await providerJson(input, url, {
    authorization: `Bearer ${input.token}`,
  });
  const id = scalarId(payload.id);
  const fullName = nonEmptyText(payload.path_with_namespace);
  const repositoryUri = credentialFreeHttps(payload.http_url_to_repo, input.providerBaseUrl);
  if (id !== input.providerRepositoryId || !fullName || !repositoryUri) {
    throw new LensProviderRepositoryError(
      "identity_mismatch",
      "GitLab returned a different or incomplete project identity",
    );
  }
  return {
    repositoryUri,
    repositoryFullName: fullName,
    providerRepositoryId: id,
    projectId: id,
  };
}

async function verifyAzureDevOpsRepository(
  input: Parameters<typeof verifyLensProviderRepository>[0],
): Promise<VerifiedLensProviderRepository> {
  if (!input.projectId) {
    throw new LensProviderRepositoryError(
      "identity_mismatch",
      "Azure DevOps repository bindings require the exact project ID",
    );
  }
  const url = providerApiUrl(
    input.providerBaseUrl,
    `${encodeURIComponent(input.projectId)}/_apis/git/repositories/${encodeURIComponent(input.providerRepositoryId)}`,
  );
  url.searchParams.set("api-version", "7.1");
  const authorization = Buffer.from(`${input.username ?? "opengeni-lens"}:${input.token}`).toString(
    "base64",
  );
  const payload = await providerJson(input, url, {
    authorization: `Basic ${authorization}`,
  });
  const project = record(payload.project);
  const id = scalarId(payload.id);
  const projectId = scalarId(project?.id);
  const repositoryName = nonEmptyText(payload.name);
  const projectName = nonEmptyText(project?.name);
  const repositoryUri = credentialFreeHttps(payload.remoteUrl, input.providerBaseUrl);
  if (
    !id ||
    id.toLowerCase() !== input.providerRepositoryId.toLowerCase() ||
    !projectId ||
    projectId.toLowerCase() !== input.projectId.toLowerCase() ||
    !repositoryName ||
    !repositoryUri
  ) {
    throw new LensProviderRepositoryError(
      "identity_mismatch",
      "Azure DevOps returned a different or incomplete repository identity",
    );
  }
  return {
    repositoryUri,
    repositoryFullName: projectName ? `${projectName}/${repositoryName}` : repositoryName,
    providerRepositoryId: id,
    projectId,
  };
}

async function providerJson(
  input: Parameters<typeof verifyLensProviderRepository>[0],
  url: URL,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const signal = AbortSignal.timeout(providerVerificationTimeoutMs);
  let response: Response;
  try {
    const requestInit = {
      headers: { accept: "application/json", ...headers },
      signal,
    } satisfies RequestInit;
    response = input.fetchImpl
      ? await input.fetchImpl(url, requestInit)
      : await pinnedFetch(url, requestInit, input.settings, {
          label: `${input.provider} Lens repository verification`,
          requireHttpsOutsideLocalTest: true,
        });
  } catch {
    throw new LensProviderRepositoryError(
      "unavailable",
      `${input.provider} repository verification is unavailable`,
    );
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await readResponseTextBounded(
      response,
      providerVerificationErrorMaxBytes,
      `${input.provider} repository verification error`,
      { signal },
    ).catch(() => undefined);
    throw new LensProviderRepositoryError(
      "denied",
      `${input.provider} credential cannot access the requested repository`,
    );
  }
  if (!response.ok) {
    await readResponseTextBounded(
      response,
      providerVerificationErrorMaxBytes,
      `${input.provider} repository verification error`,
      { signal },
    ).catch(() => undefined);
    throw new LensProviderRepositoryError(
      "unavailable",
      `${input.provider} repository verification failed`,
    );
  }
  let payload: unknown;
  try {
    payload = await readResponseJsonBounded(
      response,
      providerVerificationResponseMaxBytes,
      `${input.provider} repository metadata`,
      { signal },
    );
  } catch {
    throw new LensProviderRepositoryError(
      "unavailable",
      `${input.provider} returned invalid repository metadata`,
    );
  }
  const parsed = record(payload);
  if (!parsed) {
    throw new LensProviderRepositoryError(
      "unavailable",
      `${input.provider} returned invalid repository metadata`,
    );
  }
  return parsed;
}

function providerApiUrl(base: string, suffix: string): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${suffix}`;
  url.search = "";
  url.hash = "";
  return url;
}

function credentialFreeHttps(value: unknown, providerBaseUrl: string): string | null {
  if (typeof value !== "string") return null;
  let candidate: URL;
  const provider = new URL(providerBaseUrl);
  try {
    candidate = new URL(value);
  } catch {
    return null;
  }
  const providerPath = provider.pathname.replace(/\/+$/, "");
  if (
    candidate.protocol !== "https:" ||
    candidate.username ||
    candidate.password ||
    candidate.href.length > 2048 ||
    candidate.host.toLowerCase() !== provider.host.toLowerCase() ||
    (providerPath !== "" &&
      providerPath !== "/" &&
      candidate.pathname !== providerPath &&
      !candidate.pathname.startsWith(`${providerPath}/`))
  ) {
    return null;
  }
  return candidate.href;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scalarId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0 && value.length <= 512) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : null;
}
