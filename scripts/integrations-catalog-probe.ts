import type { CatalogIntegrationRow, NormalizedCatalogSnapshot } from "./import-integrations-catalog";

export type CatalogProbeStatus = "real" | "junk" | "unverified";
export type CatalogProbeReason =
  | "mcp_json_rpc"
  | "mcp_sse"
  | "auth_challenge"
  | "http_not_found"
  | "connection_error"
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
};

export type CatalogProbeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ProbeCatalogOptions = {
  fetchImpl?: CatalogProbeFetch;
  concurrency?: number;
  timeoutMs?: number;
  overallBudgetMs?: number;
  now?: () => number;
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

export async function probeCatalogSnapshot(
  normalized: NormalizedCatalogSnapshot,
  options: ProbeCatalogOptions = {},
): Promise<ProbedCatalogSnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(timeoutMs, options.overallBudgetMs ?? DEFAULT_OVERALL_BUDGET_MS);
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
      const outcome = now() >= deadline
        ? { status: "unverified" as const, reason: "timeout" as const, detail: "overall_budget_exhausted" }
        : await probeMcpEndpoint(row.mcpUrl, { fetchImpl, timeoutMs: Math.min(timeoutMs, Math.max(1, deadline - now())) });
      outcomes[index] = { domain: row.domain, mcpUrl: row.mcpUrl, outcome };
      if (outcome.status !== "junk") {
        keptRows[index] = withProbeMetadata(row, outcome);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, normalized.rows.length) }, () => worker()));

  const compactRows = keptRows.filter((row): row is CatalogIntegrationRow => !!row);
  const compactOutcomes = outcomes.filter((item): item is ProbedCatalogSnapshot["probe"]["outcomes"][number] => !!item);
  const dropped = compactOutcomes.filter((item) => item.outcome.status === "junk").length;
  const unverified = compactOutcomes.filter((item) => item.outcome.status === "unverified").length;
  const real = compactOutcomes.filter((item) => item.outcome.status === "real").length;
  const googleapisDropped = compactOutcomes.filter((item) => item.domain.endsWith(".googleapis.com") && item.outcome.status === "junk").length;

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
        .filter((item) => item.outcome.status === "junk")
        .map((item) => ({ domain: item.domain, mcpUrl: item.mcpUrl, reason: `probe_${item.outcome.reason}` })),
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

export async function probeMcpEndpoint(url: string, input: {
  fetchImpl?: CatalogProbeFetch;
  timeoutMs?: number;
} = {}): Promise<CatalogProbeOutcome> {
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
    return classifyProbeResponse(response, await safeResponseText(response));
  } catch (error) {
    if (isAbortError(error)) {
      return { status: "unverified", reason: "timeout" };
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
  if ((httpStatus === 401 || httpStatus === 403) && hasAuthChallenge(response.headers)) {
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

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
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

function withProbeMetadata(row: CatalogIntegrationRow, outcome: CatalogProbeOutcome): CatalogIntegrationRow {
  return {
    ...row,
    probe: outcome.status === "unverified"
      ? { status: "unverified", reason: outcome.reason, httpStatus: outcome.httpStatus ?? null }
      : { status: outcome.status, reason: outcome.reason, httpStatus: outcome.httpStatus ?? null },
  };
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function hasAuthChallenge(headers: Headers): boolean {
  return !!(headers.get("www-authenticate") || headers.get("www-authenticate".toLowerCase()));
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
