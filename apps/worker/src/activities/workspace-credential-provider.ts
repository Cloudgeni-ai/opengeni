import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  CredentialProviderResponse,
  OPENGENI_SIGNATURE_HEADER,
  signOpenGeniPayload,
  type CredentialProviderRequest,
  type RunCredentialsRequest,
  type RunCredentialsResolution,
} from "@opengeni/contracts";
import {
  decryptEnvironmentValue,
  getWorkspaceCredentialProvider,
  type Database,
} from "@opengeni/db";
import { pinnedFetch, type OutboundNetworkSettings } from "@opengeni/network";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const GIT_CREDENTIALS_FILE = "git/credentials";
export const GIT_CREDENTIALS_FILE_ENV = "OPENGENI_GIT_CREDENTIALS_FILE";

export class CredentialProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialProviderError";
  }
}

export type WorkspaceRunCredentialResolver = (
  input: RunCredentialsRequest,
) => Promise<RunCredentialsResolution>;

type ProviderOk = Extract<CredentialProviderResponse, { status: "ok" }>;

function gitCredentialLine(entry: NonNullable<ProviderOk["git"]>[number]): string {
  const username = encodeURIComponent(entry.username ?? "x-access-token");
  return `https://${username}:${encodeURIComponent(entry.password)}@${entry.host}`;
}

/**
 * Turn the provider's `git` sugar into ordinary run-credential material: one
 * renewable credential-store file plus a read-only helper configured through
 * GIT_CONFIG_* environment entries appended after any the host already set.
 */
export function withGitCredentialHelper(response: ProviderOk): ProviderOk {
  if (!response.git?.length) return response;
  const environment = { ...response.environment };
  const existingCount = Number.parseInt(environment.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isFinite(existingCount) && existingCount > 0 ? existingCount : 0;
  environment[`GIT_CONFIG_KEY_${index}`] = "credential.helper";
  environment[`GIT_CONFIG_VALUE_${index}`] =
    `!f() { test "$1" = get && exec git credential-store --file="$${GIT_CREDENTIALS_FILE_ENV}" get; }; f`;
  environment.GIT_CONFIG_COUNT = String(index + 1);
  return {
    ...response,
    environment,
    files: [
      ...(response.files ?? []),
      {
        path: GIT_CREDENTIALS_FILE,
        content: `${response.git.map(gitCredentialLine).join("\n")}\n`,
        mode: "0400",
      },
    ],
    fileEnvironment: {
      ...response.fileEnvironment,
      [GIT_CREDENTIALS_FILE_ENV]: GIT_CREDENTIALS_FILE,
    },
  };
}

export function credentialProviderRequestBody(
  input: RunCredentialsRequest,
  initiatingHumanSubjectId: string | null,
): CredentialProviderRequest {
  return {
    type: "credentials.request",
    purpose: input.purpose,
    forceRefresh: input.forceRefresh,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    rootSessionId: input.rootSessionId,
    parentSessionId: input.parentSessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    initiator: { kind: input.initiator.kind, subjectId: input.initiator.subjectId },
    initiatingHumanSubjectId,
    sandboxBackend: input.effectiveSandboxBackend,
    sandboxOs: input.sandboxOs,
  };
}

/** Drop undefined-valued keys; the runtime normalizer re-validates everything. */
function wire<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function toRunCredentialsResolution(
  response: CredentialProviderResponse,
  scope: { accountId: string; workspaceId: string; sessionId: string },
): RunCredentialsResolution {
  if (response.status === "not_applicable") return { status: "not_applicable", ...scope };
  if (response.status === "auth_needed") {
    return wire({ status: "auth_needed", ...scope, authNeeded: response.authNeeded });
  }
  const { git: _git, ...material } = withGitCredentialHelper(response);
  return wire({ ...material, status: "ok", ...scope, environment: material.environment ?? {} });
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new CredentialProviderError("credential provider response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new CredentialProviderError("credential provider response is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export type WorkspaceCredentialProviderDeps = {
  fetch?: typeof pinnedFetch;
};

/**
 * Resolve the workspace's configured HTTP credential provider, if any. The
 * returned resolver has the same contract as a host `runCredentials` port, so
 * provisioning, file materialization, renewal, and reconnect notices reuse the
 * existing run-credential lifecycle unchanged.
 */
export async function workspaceCredentialProviderResolver(
  db: Database,
  settings: Settings,
  scope: { accountId: string; workspaceId: string },
  initiatingHumanSubjectId: string | null,
  deps: WorkspaceCredentialProviderDeps = {},
): Promise<WorkspaceRunCredentialResolver | null> {
  const row = await getWorkspaceCredentialProvider(db, scope);
  if (!row?.enabled) return null;
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new CredentialProviderError(
      "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required to use a workspace credential provider",
    );
  }
  const secret = decryptEnvironmentValue(key, row.secretEncrypted);
  const fetchImpl = deps.fetch ?? pinnedFetch;
  const network: OutboundNetworkSettings = settings;
  return async (input) => {
    const echo = {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    };
    const body = JSON.stringify(credentialProviderRequestBody(input, initiatingHumanSubjectId));
    let status: number;
    let text: string;
    try {
      const response = await fetchImpl(
        row.url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "OpenGeni-CredentialProvider/1",
            [OPENGENI_SIGNATURE_HEADER]: await signOpenGeniPayload(secret, body),
          },
          body,
          signal: AbortSignal.timeout(row.timeoutMs),
        },
        network,
        { label: "Workspace credential provider", requireHttpsOutsideLocalTest: true },
      );
      status = response.status;
      text = await readBoundedText(response);
    } catch (error) {
      return failure(input, echo, `request failed: ${errorName(error)}`);
    }
    if (status < 200 || status >= 300) {
      return failure(input, echo, `returned HTTP ${status}`);
    }
    let parsed: CredentialProviderResponse;
    try {
      parsed = CredentialProviderResponse.parse(JSON.parse(text));
    } catch {
      return failure(input, echo, "returned an invalid response body");
    }
    return toRunCredentialsResolution(parsed, echo);
  };
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError" ? "timeout" : error.name;
  }
  return "unknown";
}

/**
 * A failed renewal throws so the renewal loop keeps the last good material and
 * retries with backoff. A failed first provision degrades to a visible
 * reconnect notice instead of blocking the turn.
 */
function failure(
  input: RunCredentialsRequest,
  echo: { accountId: string; workspaceId: string; sessionId: string },
  reason: string,
): RunCredentialsResolution {
  const message = `Workspace credential provider ${reason}`;
  if (input.purpose === "renewal") throw new CredentialProviderError(message);
  return {
    status: "auth_needed",
    ...echo,
    authNeeded: [{ reason: "refresh_failed", message }],
  };
}
