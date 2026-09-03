import type {
  CatalogIntegrationRow,
  NormalizedCatalogSnapshot,
} from "./import-integrations-catalog";
import {
  DestinationPolicyError,
  McpOAuthDiscoveryError,
  OAUTH_MAX_RESPONSE_BYTES,
  parseMcpOAuthChallenge,
  pinnedFetch,
  readResponseJsonBounded,
  resolveMcpOAuthDiscovery,
  validateHttpUrl,
  type McpOAuthDiscoveryClassification,
  type McpOAuthMetadataFetchResult,
} from "../packages/network/src/index";

export type CatalogProbeStatus = "real" | "junk" | "unverified";
export type CatalogProbeReason =
  | "mcp_json_rpc"
  | "mcp_sse"
  | "auth_challenge"
  | "http_not_found"
  | "connection_error"
  | "rate_limited"
  | "timeout"
  | "html_response"
  | "non_mcp_json"
  | "non_mcp_text"
  | "http_status";

export type CatalogProbeOutcome = {
  status: CatalogProbeStatus;
  reason: CatalogProbeReason;
  httpStatus?: number;
  detail?: string;
  oauthDiscovery?: McpOAuthDiscoveryClassification;
};

export type CatalogProbeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ProbeCatalogOptions = {
  fetchImpl?: CatalogProbeFetch;
  concurrency?: number;
  timeoutMs?: number;
  overallBudgetMs?: number;
  now?: () => number;
  /**
   * Extra attempts for a transient outcome (connection error, timeout, rate limit, 5xx).
   * A live endpoint that flakes once under probe concurrency must not be
   * evicted from the snapshot on that single observation.
   */
  transientRetries?: number;
  transientRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type ProbedCatalogSnapshot = NormalizedCatalogSnapshot & {
  rows: CatalogIntegrationRow[];
  probe: {
    kept: number;
    dropped: number;
    real: number;
    unverified: number;
    googleapisDropped: number;
    outcomes: Array<{ domain: string; mcpUrl: string; outcome: CatalogProbeOutcome }>;
  };
};

const DEFAULT_CONCURRENCY = 24;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_OVERALL_BUDGET_MS = 10 * 60_000;
const DEFAULT_TRANSIENT_RETRIES = 2;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 2_000;

export function isTransientProbeOutcome(outcome: CatalogProbeOutcome): boolean {
  if (outcome.status === "real") {
    return false;
  }
  if (
    outcome.reason === "connection_error" ||
    outcome.reason === "rate_limited" ||
    outcome.reason === "timeout"
  ) {
    return true;
  }
  return outcome.reason === "http_status" && (outcome.httpStatus ?? 0) >= 500;
}

export async function probeCatalogSnapshot(
  normalized: NormalizedCatalogSnapshot,
  options: ProbeCatalogOptions = {},
): Promise<ProbedCatalogSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const now = options.now ?? Date.now;
  const transientRetries = Math.max(0, options.transientRetries ?? DEFAULT_TRANSIENT_RETRIES);
  const transientRetryDelayMs = Math.max(
    0,
    options.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS,
  );
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline =
    now() + Math.max(timeoutMs, options.overallBudgetMs ?? DEFAULT_OVERALL_BUDGET_MS);
  const outcomes: ProbedCatalogSnapshot["probe"]["outcomes"] = [];
  const keptRows: CatalogIntegrationRow[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const row = normalized.rows[index];
      if (!row) {
        return;
      }
      const budgetExhausted: CatalogProbeOutcome = {
        status: "unverified",
        reason: "timeout",
        detail: "overall_budget_exhausted",
      };
      let outcome: CatalogProbeOutcome = budgetExhausted;
      for (let attempt = 0; attempt <= transientRetries && now() < deadline; attempt += 1) {
        if (attempt > 0 && transientRetryDelayMs > 0) {
          await sleep(transientRetryDelayMs * attempt);
          // The retry sleep may have consumed the remaining budget. A probe
          // started now would run with a 1 ms timeout and report `timeout`
          // as if the endpoint were slow; report the exhausted budget instead.
          if (now() >= deadline) {
            outcome = budgetExhausted;
            break;
          }
        }
        outcome = await probeMcpEndpoint(row.mcpUrl, {
          fetchImpl,
          timeoutMs: Math.min(timeoutMs, Math.max(1, deadline - now())),
        });
        if (!isTransientProbeOutcome(outcome)) {
          break;
        }
      }
      outcomes[index] = { domain: row.domain, mcpUrl: row.mcpUrl, outcome };
      if (outcome.status === "real") {
        keptRows[index] = withProbeMetadata(row, outcome);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, normalized.rows.length) }, () => worker()),
  );

  const compactRows = keptRows.filter((row): row is CatalogIntegrationRow => !!row);
  const compactOutcomes = outcomes.filter(
    (item): item is ProbedCatalogSnapshot["probe"]["outcomes"][number] => !!item,
  );
  const dropped = compactOutcomes.filter((item) => item.outcome.status !== "real").length;
  const unverified = compactOutcomes.filter((item) => item.outcome.status === "unverified").length;
  const real = compactOutcomes.filter((item) => item.outcome.status === "real").length;
  const googleapisDropped = compactOutcomes.filter(
    (item) => item.domain.endsWith(".googleapis.com") && item.outcome.status === "junk",
  ).length;

  return {
    ...normalized,
    rows: compactRows,
    cleaning: {
      ...normalized.cleaning,
      outputRows: compactRows.length,
      skippedRows: normalized.skipped.length + dropped,
    },
    skipped: [
      ...normalized.skipped,
      ...compactOutcomes
        .filter((item) => item.outcome.status !== "real")
        .map((item) => ({
          domain: item.domain,
          mcpUrl: null,
          reason: `probe_${item.outcome.reason}`,
        })),
    ],
    probe: {
      kept: compactRows.length,
      dropped,
      real,
      unverified,
      googleapisDropped,
      outcomes: compactOutcomes,
    },
  };
}

export async function probeMcpEndpoint(
  url: string,
  input: {
    fetchImpl?: CatalogProbeFetch;
    timeoutMs?: number;
  } = {},
): Promise<CatalogProbeOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "opengeni-catalog-refresh", version: "0.1.0" },
        },
      }),
      signal: controller.signal,
    });
    const outcome = classifyProbeResponse(response, await safeResponseText(response));
    if (outcome.reason !== "auth_challenge") {
      return outcome;
    }
    const challenge = parseMcpOAuthChallenge(response.headers.get("www-authenticate"));
    try {
      const discovery = await resolveMcpOAuthDiscovery({
        resourceUrl: url,
        challenge,
        fetchMetadata: ({ url: metadataUrl }) =>
          fetchCatalogOAuthMetadata(metadataUrl, fetchImpl, controller.signal),
        validateEndpoint: (rawUrl, label) => validateHttpUrl(rawUrl, { label }),
        canonicalizeResource: canonicalCatalogOAuthResource,
      });
      return { ...outcome, oauthDiscovery: discovery.classification };
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) throw error;
      if (!(error instanceof McpOAuthDiscoveryError)) {
        if (error instanceof CatalogOAuthMetadataTransientError) throw error;
        if (
          !(error instanceof CatalogOAuthMetadataBrokenError) &&
          !(error instanceof DestinationPolicyError)
        ) {
          throw error;
        }
      }
      return {
        ...outcome,
        oauthDiscovery:
          error instanceof McpOAuthDiscoveryError ? error.classification : "oauth_discovery_broken",
      };
    }
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      return { status: "unverified", reason: "timeout" };
    }
    if (error instanceof CatalogOAuthMetadataTransientError) {
      return {
        status: "unverified",
        reason: error.httpStatus === 429 ? "rate_limited" : "http_status",
        httpStatus: error.httpStatus,
      };
    }
    return {
      status: "junk",
      reason: "connection_error",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function classifyProbeResponse(response: Response, body: string): CatalogProbeOutcome {
  const httpStatus = response.status;
  if (
    (httpStatus === 401 || httpStatus === 403) &&
    parseMcpOAuthChallenge(response.headers.get("www-authenticate")).scheme
  ) {
    return { status: "real", reason: "auth_challenge", httpStatus };
  }
  if (httpStatus === 404 || httpStatus === 410) {
    return { status: "junk", reason: "http_not_found", httpStatus };
  }
  if (httpStatus >= 500) {
    return { status: "unverified", reason: "http_status", httpStatus };
  }
  if (!response.ok) {
    return { status: "unverified", reason: "http_status", httpStatus };
  }

  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const sample = body.slice(0, 4096);
  if (contentType === "text/event-stream" || looksLikeSse(sample)) {
    return sampleHasJsonRpc(sample)
      ? { status: "real", reason: "mcp_sse", httpStatus }
      : { status: "junk", reason: "non_mcp_text", httpStatus };
  }
  if (contentType === "text/html" || looksLikeHtml(sample)) {
    return { status: "junk", reason: "html_response", httpStatus };
  }

  const json = parseJson(sample);
  if (json) {
    return looksLikeMcpJsonRpc(json)
      ? { status: "real", reason: "mcp_json_rpc", httpStatus }
      : { status: "junk", reason: "non_mcp_json", httpStatus };
  }
  return { status: "junk", reason: "non_mcp_text", httpStatus };
}

function withProbeMetadata(
  row: CatalogIntegrationRow,
  outcome: CatalogProbeOutcome,
): CatalogIntegrationRow {
  return {
    ...row,
    probe:
      outcome.status === "unverified"
        ? { status: "unverified", reason: outcome.reason, httpStatus: outcome.httpStatus ?? null }
        : {
            status: outcome.status,
            reason: outcome.reason,
            httpStatus: outcome.httpStatus ?? null,
            ...(outcome.oauthDiscovery ? { oauthDiscovery: outcome.oauthDiscovery } : {}),
          },
  };
}

async function fetchCatalogOAuthMetadata(
  url: string,
  fetchImpl: CatalogProbeFetch,
  signal: AbortSignal,
): Promise<McpOAuthMetadataFetchResult> {
  const response = await fetchCatalogOAuthResponse(url, fetchImpl, signal);
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "absent", url, httpStatus: response.status };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const message = `OAuth metadata endpoint returned HTTP ${response.status}`;
    if (response.status === 429 || response.status >= 500) {
      throw new CatalogOAuthMetadataTransientError(message, response.status);
    }
    throw new CatalogOAuthMetadataBrokenError(message);
  }
  let payload: unknown;
  try {
    payload = await readResponseJsonBounded<unknown>(
      response,
      OAUTH_MAX_RESPONSE_BYTES,
      "catalog OAuth metadata response",
      { signal },
    );
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    throw new CatalogOAuthMetadataBrokenError("catalog OAuth metadata response was invalid", {
      cause: error,
    });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CatalogOAuthMetadataBrokenError(
      "catalog OAuth metadata response was not a JSON object",
    );
  }
  return { status: "present", url, document: payload as Record<string, unknown> };
}

async function fetchCatalogOAuthResponse(
  rawUrl: string,
  fetchImpl: CatalogProbeFetch,
  signal: AbortSignal,
  hop = 0,
): Promise<Response> {
  const url = validateHttpUrl(rawUrl, { label: "catalog OAuth metadata" });
  const init: RequestInit = {
    headers: { accept: "application/json" },
    signal,
    redirect: "manual",
  };
  const response =
    fetchImpl === fetch
      ? await pinnedFetch(
          url,
          init,
          { environment: "production", integrationsAllowPrivateNetworkTargets: false },
          {
            label: "catalog OAuth metadata",
            requireHttpsOutsideLocalTest: true,
          },
        )
      : await fetchImpl(url, init);
  if (response.status < 300 || response.status >= 400) return response;
  if (hop >= 3) {
    await response.body?.cancel().catch(() => undefined);
    throw new CatalogOAuthMetadataBrokenError(
      "catalog OAuth metadata exceeded maximum redirect hops",
    );
  }
  const location = response.headers.get("location");
  if (!location) {
    await response.body?.cancel().catch(() => undefined);
    throw new CatalogOAuthMetadataBrokenError(
      "catalog OAuth metadata redirect was missing Location",
    );
  }
  let nextUrl: string;
  try {
    nextUrl = new URL(location, url).toString();
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw new CatalogOAuthMetadataBrokenError(
      "catalog OAuth metadata redirect Location was invalid",
      { cause: error },
    );
  }
  await response.body?.cancel().catch(() => undefined);
  return await fetchCatalogOAuthResponse(nextUrl, fetchImpl, signal, hop + 1);
}

class CatalogOAuthMetadataBrokenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogOAuthMetadataBrokenError";
  }
}

class CatalogOAuthMetadataTransientError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "CatalogOAuthMetadataTransientError";
  }
}

function canonicalCatalogOAuthResource(rawResource: string): string {
  const trimmed = rawResource.trim();
  if (!trimmed) throw new Error("OAuth resource was empty");
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.hash = "";
      return validateHttpUrl(url.toString(), { label: "OAuth resource" });
    }
    return trimmed;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("OAuth resource was invalid", { cause: error });
    }
    throw error;
  }
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function looksLikeSse(text: string): boolean {
  return /^event:|^data:/m.test(text);
}

function sampleHasJsonRpc(text: string): boolean {
  return /"jsonrpc"\s*:\s*"2\.0"|protocolVersion|capabilities/.test(text);
}

function looksLikeHtml(text: string): boolean {
  return /^\s*<!doctype html/i.test(text) || /^\s*<html[\s>]/i.test(text);
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function looksLikeMcpJsonRpc(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(looksLikeMcpJsonRpc);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc === "2.0" && ("result" in record || "error" in record)) {
    return true;
  }
  const result = record.result;
  if (result && typeof result === "object") {
    const resultRecord = result as Record<string, unknown>;
    return typeof resultRecord.protocolVersion === "string" || !!resultRecord.capabilities;
  }
  return false;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
