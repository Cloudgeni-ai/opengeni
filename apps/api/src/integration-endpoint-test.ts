import {
  CredentialProviderResponse,
  OPENGENI_SIGNATURE_HEADER,
  signOpenGeniPayload,
  type IntegrationEndpointTestResult,
} from "@opengeni/contracts";
import {
  DestinationPolicyError,
  pinnedFetch,
  type OutboundNetworkSettings,
} from "@opengeni/network";

/**
 * One synchronous, signed test request to an integration endpoint, sent
 * through the same pinned outbound policy as real deliveries. Nothing is
 * stored. A provider's credential values never leave this function: only
 * their names are returned.
 */

const RESPONSE_EXCERPT_BYTES = 1024;
/** A provider answer is parsed in full, like a real run's (5 MiB). */
const PROVIDER_RESPONSE_BYTES = 5 * 1024 * 1024;

export type IntegrationEndpointTestInput = {
  kind: "webhook" | "credential-provider";
  url: string;
  secret: string;
  /** The exact body to sign and send. */
  body: string;
  /** Extra identity headers (the webhook event id). */
  headers?: Record<string, string>;
  timeoutMs: number;
  settings: OutboundNetworkSettings;
  fetch?: typeof pinnedFetch;
  now?: () => number;
};

function causeCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** What went wrong reaching the endpoint, in words an administrator can act on. */
export function integrationTestNetworkError(error: unknown): string {
  if (error instanceof DestinationPolicyError) {
    if (error.reason === "https_required") return "The URL must use https.";
    if (error.reason === "dns_failed" || error.reason === "dns_empty") {
      return "The hostname couldn't be resolved. Check the URL.";
    }
    if (error.reason === "private_or_special_use") {
      return "The URL points to a private network address, which this server doesn't allow.";
    }
    return `${error.message}.`;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "The endpoint didn't answer in time.";
  }
  switch (causeCode(error)) {
    case "ECONNREFUSED":
      return "The connection was refused. Check that the service is running.";
    case "ECONNRESET":
      return "The connection was reset before the endpoint answered.";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "The hostname couldn't be resolved. Check the URL.";
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "The endpoint's TLS certificate isn't trusted.";
    default:
      return "The endpoint couldn't be reached.";
  }
}

async function readUpTo(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

function excerpt(text: string, truncated: boolean): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const bounded = new TextDecoder().decode(
    new TextEncoder().encode(trimmed).subarray(0, RESPONSE_EXCERPT_BYTES),
  );
  return truncated || bounded.length < trimmed.length ? `${bounded}…` : bounded;
}

/** The names of what a run would receive. Values are dropped here. */
export function credentialProviderTestSummary(
  response: CredentialProviderResponse,
): NonNullable<IntegrationEndpointTestResult["credentials"]> {
  const authNeeded = (response.status === "not_applicable" ? [] : (response.authNeeded ?? [])).map(
    (entry) => ({
      reason: entry.reason,
      providerDomain: entry.providerDomain ?? null,
      message: entry.message ?? null,
    }),
  );
  if (response.status !== "ok") {
    return {
      status: response.status,
      environment: [],
      files: [],
      git: [],
      mcp: [],
      expiresAt: null,
      authNeeded,
    };
  }
  return {
    status: "ok",
    environment: Object.keys(response.environment ?? {}).sort(),
    files: (response.files ?? []).map((file) => file.path),
    git: (response.git ?? []).map((entry) => entry.host.toLowerCase()),
    mcp: (response.mcp ?? []).map((entry) => entry.url),
    expiresAt: response.expiresAt ?? null,
    authNeeded,
  };
}

function statusAdvice(kind: IntegrationEndpointTestInput["kind"], status: number): string {
  if (status >= 300 && status < 400) {
    return `The endpoint answered HTTP ${status}. Redirects aren't followed: use the final URL.`;
  }
  if (status === 401 || status === 403) {
    return `The endpoint refused the request (HTTP ${status}). Check that it verifies with this ${
      kind === "webhook" ? "webhook's" : "provider's"
    } signing secret.`;
  }
  if (status === 404 || status === 405) {
    return `The endpoint answered HTTP ${status}. Check the URL and that it accepts POST.`;
  }
  return `The endpoint answered HTTP ${status}.`;
}

export async function sendIntegrationEndpointTest(
  input: IntegrationEndpointTestInput,
): Promise<IntegrationEndpointTestResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const base = { request: input.body, credentials: null };
  let response: Response;
  try {
    response = await (input.fetch ?? pinnedFetch)(
      input.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent":
            input.kind === "webhook" ? "OpenGeni-Webhooks/1" : "OpenGeni-CredentialProvider/1",
          [OPENGENI_SIGNATURE_HEADER]: await signOpenGeniPayload(input.secret, input.body),
          ...input.headers,
        },
        body: input.body,
        signal: AbortSignal.timeout(input.timeoutMs),
      },
      input.settings,
      {
        label: input.kind === "webhook" ? "Webhook" : "Credential provider",
        requireHttpsOutsideLocalTest: true,
      },
    );
  } catch (error) {
    return {
      ...base,
      ok: false,
      status: null,
      durationMs: elapsed(),
      error: integrationTestNetworkError(error),
      responseBody: null,
    };
  }
  const status = response.status;
  const success = status >= 200 && status < 300;
  let read: { text: string; truncated: boolean };
  try {
    read = await readUpTo(
      response,
      success && input.kind === "credential-provider"
        ? PROVIDER_RESPONSE_BYTES
        : RESPONSE_EXCERPT_BYTES,
    );
  } catch (error) {
    return {
      ...base,
      ok: false,
      status,
      durationMs: elapsed(),
      error: integrationTestNetworkError(error),
      responseBody: null,
    };
  }
  const durationMs = elapsed();
  if (!success) {
    return {
      ...base,
      ok: false,
      status,
      durationMs,
      error: statusAdvice(input.kind, status),
      responseBody: excerpt(read.text, read.truncated),
    };
  }
  if (input.kind === "webhook") {
    return {
      ...base,
      ok: true,
      status,
      durationMs,
      error: null,
      responseBody: excerpt(read.text, read.truncated),
    };
  }
  // A successful provider answer may carry credentials: never echo its bytes.
  if (read.truncated) {
    return {
      ...base,
      ok: false,
      status,
      durationMs,
      error: "The answer is larger than 5 MB.",
      responseBody: null,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    return {
      ...base,
      ok: false,
      status,
      durationMs,
      error:
        'The answer isn\'t JSON. Return a credential response such as {"status":"not_applicable"}.',
      responseBody: null,
    };
  }
  const parsed = CredentialProviderResponse.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    return {
      ...base,
      ok: false,
      status,
      durationMs,
      error: `The answer isn't a valid credential response${where}: ${issue?.message ?? "invalid"}.`,
      responseBody: null,
    };
  }
  return {
    ...base,
    ok: true,
    status,
    durationMs,
    error: null,
    responseBody: null,
    credentials: credentialProviderTestSummary(parsed.data),
  };
}
