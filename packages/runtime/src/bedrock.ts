/**
 * Amazon Bedrock transport for native Claude Messages (docs/amazon-bedrock.md).
 *
 * Requests keep the Anthropic Messages format and go to bedrock-runtime's
 * `/anthropic/v1/messages`, signed with SigV4. Credentials come from the AWS
 * SDK default chain (IRSA, EKS Pod Identity, ECS task role, instance role,
 * environment or profile), which refreshes them before they expire. With an
 * attribution role, each person's requests use that role with their own
 * session name, which AWS CUR 2.0 records as the request's IAM principal.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac } from "node:crypto";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import {
  bedrockClaudeBaseModelId,
  claudeNativeModelProfile,
  setBedrockDiscoveredModels,
  type BedrockDiscoveredModel,
  type ResolvedModelProvider,
  type Settings,
} from "@opengeni/config";

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}
type CredentialProvider = () => Promise<AwsCredentials>;

type SourceData = string | ArrayBuffer | ArrayBufferView;
const bytes = (data: SourceData): string | Uint8Array =>
  typeof data === "string"
    ? data
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);

/** SHA-256 / HMAC-SHA-256 for the SigV4 signer, from node:crypto. */
class Sha256 {
  private hash;
  constructor(private readonly secret?: SourceData) {
    this.hash = secret ? createHmac("sha256", bytes(secret)) : createHash("sha256");
  }
  update(data: SourceData): void {
    this.hash.update(bytes(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
  reset(): void {
    this.hash = this.secret ? createHmac("sha256", bytes(this.secret)) : createHash("sha256");
  }
}

let baseCredentials: CredentialProvider | undefined;
/** The process's AWS identity; the SDK provider memoizes and refreshes it. */
function deploymentCredentials(): CredentialProvider {
  baseCredentials ??= defaultProvider() as CredentialProvider;
  return baseCredentials;
}

/** Test seam: replace the AWS identity (undefined restores the default chain). */
export function setBedrockCredentialProviderForTests(provider: CredentialProvider | undefined) {
  baseCredentials = provider;
  attributedSessions.clear();
}

const callers = new AsyncLocalStorage<{ subjectId: string }>();

/**
 * Run `fn` with Bedrock requests attributed to this person (when the
 * deployment configured an attribution role). Without a subject, requests in
 * `fn` use the deployment's own identity, even inside another person's scope.
 */
export function withBedrockCaller<T>(subjectId: string | null | undefined, fn: () => T): T {
  return subjectId ? callers.run({ subjectId }, fn) : callers.exit(fn);
}

/**
 * The STS session name for a person: `og-` and their stable user id (other
 * characters than STS allows become `-`), or a digest of it when it is too
 * long or looks like an email address. Never an email address.
 */
export function bedrockSessionName(subjectId: string): string {
  const readable = subjectId.replace(/[^\w+=,.-]/gu, "-");
  return readable.length <= 61 && !subjectId.includes("@")
    ? `og-${readable}`
    : `og-${createHash("sha256").update(subjectId).digest("hex").slice(0, 40)}`;
}

const SESSION_LIMIT = 2_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const STS_TIMEOUT_MS = 10_000;
const attributedSessions = new Map<
  string,
  { credentials?: AwsCredentials; pending?: Promise<AwsCredentials> }
>();

function xmlField(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([^<]*)</${name}>`, "u").exec(xml)?.[1];
}

/** Keep AWS account ids out of messages people see in a chat. */
function redactAccountIds(text: string): string {
  return text.replace(/(?<![\d])\d{12}(?![\d])/gu, "<account>");
}

async function assumeRole(
  region: string,
  roleArn: string,
  sessionName: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<AwsCredentials> {
  const url = new URL(`https://sts.${region}.amazonaws.com/`);
  const body = new URLSearchParams({
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    DurationSeconds: "3600",
  }).toString();
  const signed = await new SignatureV4({
    credentials: deploymentCredentials(),
    region,
    service: "sts",
    sha256: Sha256,
  }).sign({
    method: "POST",
    protocol: "https:",
    hostname: url.hostname,
    path: "/",
    headers: { host: url.host, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const { host: _host, ...headers } = signed.headers;
  let response: Response;
  let xml: string;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(STS_TIMEOUT_MS),
    });
    xml = await response.text();
  } catch (error) {
    throw new Error(
      `Amazon Bedrock attribution could not reach STS in ${region} to assume ${redactAccountIds(roleArn)} (${error instanceof Error ? error.name : "network error"}).`,
      { cause: error },
    );
  }
  const accessKeyId = xmlField(xml, "AccessKeyId");
  const secretAccessKey = xmlField(xml, "SecretAccessKey");
  const sessionToken = xmlField(xml, "SessionToken");
  const expiration = xmlField(xml, "Expiration");
  if (!response.ok || !accessKeyId || !secretAccessKey || !sessionToken)
    throw new Error(
      `Amazon Bedrock attribution could not assume ${redactAccountIds(roleArn)} (${xmlField(xml, "Code") ?? `HTTP ${response.status}`}). Check the role's trust policy (docs/amazon-bedrock.md).`,
    );
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    ...(expiration ? { expiration: new Date(expiration) } : {}),
  };
}

/** The credentials one request signs with: the person's role session, or the deployment's. */
async function requestCredentials(
  bedrock: NonNullable<ResolvedModelProvider["bedrock"]>,
  fetchImpl: typeof globalThis.fetch,
): Promise<AwsCredentials> {
  const caller = callers.getStore();
  if (!bedrock.attributionRoleArn || !caller) return deploymentCredentials()();
  const sessionName = bedrockSessionName(caller.subjectId);
  const key = `${bedrock.region}\0${bedrock.attributionRoleArn}\0${sessionName}`;
  let entry = attributedSessions.get(key);
  const fresh = (credentials: AwsCredentials | undefined) =>
    credentials &&
    (!credentials.expiration || credentials.expiration.getTime() - Date.now() > REFRESH_MARGIN_MS);
  if (entry && fresh(entry.credentials)) return entry.credentials!;
  if (entry?.pending) return entry.pending;
  if (!entry) {
    if (attributedSessions.size >= SESSION_LIMIT)
      attributedSessions.delete(attributedSessions.keys().next().value!);
    entry = {};
    attributedSessions.set(key, entry);
  }
  const current = entry;
  current.pending = assumeRole(
    bedrock.region,
    bedrock.attributionRoleArn,
    sessionName,
    fetchImpl,
  ).then(
    (credentials) => {
      current.credentials = credentials;
      delete current.pending;
      return credentials;
    },
    (error: unknown) => {
      delete current.pending;
      throw error;
    },
  );
  return current.pending;
}

async function signedRequest(
  url: URL,
  init: { method: string; headers: Headers; body?: string },
  options: {
    region: string;
    service: string;
    credentials: AwsCredentials;
  },
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { host: url.host };
  init.headers.forEach((value, name) => {
    if (name !== "host" && name !== "content-length") headers[name] = value;
  });
  const signed = await new SignatureV4({
    credentials: options.credentials,
    region: options.region,
    service: options.service,
    sha256: Sha256,
  }).sign({
    method: init.method,
    protocol: url.protocol,
    hostname: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  // fetch sets Host itself; the signature already covers it.
  const { host: _host, ...rest } = signed.headers;
  return rest;
}

const AWS_ERROR_TYPES: Record<string, string> = {
  ThrottlingException: "rate_limit_error",
  ServiceQuotaExceededException: "rate_limit_error",
  ServiceUnavailableException: "overloaded_error",
  ModelNotReadyException: "overloaded_error",
  ValidationException: "invalid_request_error",
  AccessDeniedException: "permission_error",
  ResourceNotFoundException: "not_found_error",
  UnrecognizedClientException: "authentication_error",
  ExpiredTokenException: "authentication_error",
  InvalidSignatureException: "authentication_error",
  ModelTimeoutException: "api_error",
  InternalServerException: "api_error",
  ModelErrorException: "api_error",
};

/**
 * Bedrock answers errors in AWS's shape (`{"message"}` plus
 * `x-amzn-errortype`) and its request id as `x-amzn-requestid`. Give them the
 * Anthropic shape the Messages transport classifies, keeping AWS's own
 * message and error type so the failure says what Bedrock refused.
 */
function anthropicShaped(response: Response, text?: string): Response {
  const headers = new Headers(response.headers);
  const requestId = headers.get("x-amzn-requestid");
  if (requestId && !headers.has("request-id")) headers.set("request-id", requestId);
  if (response.ok || text === undefined)
    return new Response(response.body, { status: response.status, headers });
  let body = text;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; Message?: unknown; error?: unknown };
    const message = parsed.message ?? parsed.Message;
    if (parsed.error === undefined && typeof message === "string") {
      const awsType = (headers.get("x-amzn-errortype") ?? "").split(":")[0] ?? "";
      body = JSON.stringify({
        type: "error",
        error: {
          type: AWS_ERROR_TYPES[awsType] ?? "api_error",
          message: redactAccountIds(awsType ? `${awsType}: ${message}` : message),
        },
      });
    }
  } catch {
    // Not JSON: pass it on unchanged; the transport keeps only its status.
  }
  headers.delete("content-length");
  return new Response(body, { status: response.status, headers });
}

/**
 * Anthropic beta flags Bedrock refused, per route and model, with when they
 * were refused. A refusal is retried after an hour, in case Bedrock added it.
 */
const refusedBetas = new Map<string, Map<string, number>>();
const BETA_RETRY_MS = 60 * 60_000;

/** Test seam: forget remembered Bedrock request fallbacks. */
export function resetBedrockFallbacksForTests() {
  refusedBetas.clear();
}

type Json = Record<string, any>;

const betaFlags = (headers: Headers): string[] =>
  (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((flag) => flag.trim())
    .filter(Boolean);

/** Remove these beta flags from a request, and the body fields that need them. */
function dropBetas(headers: Headers, body: Json, drop: ReadonlySet<string>): void {
  const kept = betaFlags(headers).filter((flag) => !drop.has(flag));
  if (kept.length) headers.set("anthropic-beta", kept.join(","));
  else headers.delete("anthropic-beta");
  // Prefix-bound thinking controls exist only under their beta.
  if (
    !kept.some((flag) => flag.startsWith("thinking-")) &&
    body.thinking &&
    typeof body.thinking === "object"
  )
    delete body.thinking.block_binding;
}

/**
 * The fetch an AnthropicMessagesModel uses on a Bedrock route: drops the
 * Anthropic credentials, signs with SigV4 and, if Bedrock refuses an
 * Anthropic beta flag, sends the request once more without it and leaves it
 * out for that model for an hour. Flags the error names are dropped; if it
 * names none, all are.
 */
export function bedrockFetch(
  provider: ResolvedModelProvider,
  inner: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const bedrock = provider.bedrock;
  if (!bedrock) throw new Error(`${provider.id} is not an Amazon Bedrock provider`);
  const send = async (
    url: URL,
    init: RequestInit | undefined,
    headers: Headers,
    body: string | undefined,
  ) =>
    inner(url, {
      ...init,
      method: init?.method ?? "POST",
      headers: await signedRequest(
        url,
        { method: init?.method ?? "POST", headers, ...(body === undefined ? {} : { body }) },
        {
          region: bedrock.region,
          service: "bedrock",
          credentials: await requestCredentials(bedrock, inner),
        },
      ),
      ...(body === undefined ? {} : { body }),
    });
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request)
      throw new TypeError("Amazon Bedrock requests take a URL and init, not a Request");
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    headers.delete("x-api-key");
    headers.delete("authorization");
    let parsed: Json | undefined;
    if (typeof init?.body === "string") {
      try {
        parsed = JSON.parse(init.body) as Json;
      } catch {
        parsed = undefined;
      }
    }
    const routeKey = `${provider.id}\0${provider.baseUrl ?? ""}\0${String(parsed?.model ?? url.pathname)}`;
    const refused = refusedBetas.get(routeKey);
    if (parsed && refused) {
      const now = Date.now();
      for (const [flag, at] of refused) if (now - at > BETA_RETRY_MS) refused.delete(flag);
      if (refused.size) dropBetas(headers, parsed, new Set(refused.keys()));
    }
    let body = parsed ? JSON.stringify(parsed) : (init?.body as string | undefined);
    let response = await send(url, init, headers, body);
    if (response.ok) return anthropicShaped(response);
    const text = await response.text();
    const sent = betaFlags(headers);
    if (
      response.status === 400 &&
      parsed &&
      sent.length &&
      /\bbeta\b|anthropic-beta/iu.test(text)
    ) {
      const named = sent.filter((flag) => text.includes(flag));
      const drop = new Set(named.length ? named : sent);
      const remembered = refusedBetas.get(routeKey) ?? new Map<string, number>();
      for (const flag of drop) remembered.set(flag, Date.now());
      refusedBetas.set(routeKey, remembered);
      dropBetas(headers, parsed, drop);
      body = JSON.stringify(parsed);
      response = await send(url, init, headers, body);
      if (response.ok) return anthropicShaped(response);
      return anthropicShaped(response, await response.text());
    }
    return anthropicShaped(response, text);
  };
  return wrapped as typeof globalThis.fetch;
}

const GEOS: [RegExp, string][] = [
  [/^eu-/u, "eu"],
  [/^us-gov-/u, "us-gov"],
  [/^us-/u, "us"],
  [/^ap-northeast-[13]$/u, "jp"],
  [/^ap-southeast-[24]$/u, "au"],
  [/^ap-/u, "apac"],
  [/^ca-/u, "ca"],
];

/**
 * The system profile or model id an application profile copies, read from
 * the regions of the foundation models it lists: one region is in-Region,
 * several in one geography are that geography's profile, and a model ARN
 * without a region is global. Anything else is unknown.
 */
export function bedrockApplicationProfileBaseId(
  modelArns: readonly string[],
  region: string,
): string | undefined {
  const models = modelArns
    .map((arn) => /^arn:aws[a-z-]*:bedrock:([a-z0-9-]*):\d*:foundation-model\/(.+)$/u.exec(arn))
    .filter((match): match is RegExpExecArray => match !== null);
  const modelId = models[0]?.[2];
  if (!modelId || models.some((match) => match[2] !== modelId)) return undefined;
  const regions = new Set(models.map((match) => match[1]!));
  if (regions.has("")) return `global.${modelId}`;
  if (regions.size === 1) return regions.has(region) ? modelId : undefined;
  const geos = new Set(
    [...regions].map((value) => GEOS.find(([pattern]) => pattern.test(value))?.[1] ?? value),
  );
  return geos.size === 1 ? `${[...geos][0]}.${modelId}` : undefined;
}

async function controlPlaneGet(
  settings: Pick<Settings, "bedrockRegion">,
  path: string,
  query: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
): Promise<Json> {
  const region = settings.bedrockRegion!;
  const url = new URL(`https://bedrock.${region}.amazonaws.com${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const headers = new Headers({ accept: "application/json" });
  const response = await fetchImpl(url, {
    method: "GET",
    headers: await signedRequest(
      url,
      { method: "GET", headers },
      { region, service: "bedrock", credentials: await deploymentCredentials()() },
    ),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = "";
    try {
      message = String((JSON.parse(text) as Json).message ?? "");
    } catch {
      // Keep only the status.
    }
    throw new Error(
      `Amazon Bedrock ${path} failed (HTTP ${response.status}${message ? `: ${message.slice(0, 200)}` : ""})`,
    );
  }
  return JSON.parse(text) as Json;
}

async function* pages(
  settings: Pick<Settings, "bedrockRegion">,
  path: string,
  query: Record<string, string>,
  key: string,
  fetchImpl: typeof globalThis.fetch,
): AsyncGenerator<Json> {
  let nextToken: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const result = await controlPlaneGet(
      settings,
      path,
      { ...query, ...(nextToken ? { nextToken } : {}) },
      fetchImpl,
    );
    for (const item of (result[key] as Json[] | undefined) ?? []) yield item;
    nextToken = typeof result.nextToken === "string" ? result.nextToken : undefined;
    if (!nextToken) return;
  }
  throw new Error(
    `Amazon Bedrock ${path} returned more than 50 pages; the model list is incomplete`,
  );
}

/**
 * The Claude models this account offers in the region: active system
 * inference profiles (global and geographic), on-demand foundation models,
 * and application inference profiles with the base model each one copies.
 * Only models with a reviewed native Claude profile are listed; others can
 * still be named in OPENGENI_BEDROCK_MODELS.
 */
export async function discoverBedrockModels(
  settings: Pick<Settings, "bedrockRegion">,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<BedrockDiscoveredModel[]> {
  const region = settings.bedrockRegion;
  if (!region) return [];
  const known = (id: string) => claudeNativeModelProfile(id) !== undefined;
  const found: BedrockDiscoveredModel[] = [];
  for await (const profile of pages(
    settings,
    "/inference-profiles",
    { type: "SYSTEM_DEFINED", maxResults: "1000" },
    "inferenceProfileSummaries",
    fetchImpl,
  )) {
    const id = profile.inferenceProfileId;
    if (typeof id === "string" && profile.status === "ACTIVE" && known(id))
      found.push({ upstreamModelId: id });
  }
  for await (const model of pages(
    settings,
    "/foundation-models",
    { byProvider: "Anthropic", byInferenceType: "ON_DEMAND" },
    "modelSummaries",
    fetchImpl,
  )) {
    const id = model.modelId;
    if (typeof id === "string" && model.modelLifecycle?.status !== "LEGACY" && known(id))
      found.push({ upstreamModelId: id });
  }
  for await (const profile of pages(
    settings,
    "/inference-profiles",
    { type: "APPLICATION", maxResults: "1000" },
    "inferenceProfileSummaries",
    fetchImpl,
  )) {
    const arn = profile.inferenceProfileArn;
    const base = bedrockApplicationProfileBaseId(
      ((profile.models as Json[] | undefined) ?? []).map((model) => String(model.modelArn ?? "")),
      region,
    );
    if (typeof arn !== "string" || profile.status !== "ACTIVE" || !base) continue;
    if (!bedrockClaudeBaseModelId(base)) continue;
    found.push({
      upstreamModelId: arn,
      baseUpstreamModelId: base,
      ...(typeof profile.inferenceProfileName === "string"
        ? { name: profile.inferenceProfileName }
        : {}),
    });
  }
  return found;
}

let discoveryTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Fill the Bedrock model list from discovery now and every 15 minutes. The
 * first attempt is bounded by `startupTimeoutMs`; a failed attempt keeps the
 * previous list and is reported through `onError`. Returns a function that
 * stops the refresh.
 */
export async function startBedrockModelDiscovery(
  settings: Pick<Settings, "bedrockRegion" | "bedrockModelDiscovery">,
  options: { onError?: (error: unknown) => void; startupTimeoutMs?: number } = {},
): Promise<() => void> {
  const stop = () => {
    clearInterval(discoveryTimer);
    discoveryTimer = undefined;
  };
  if (!settings.bedrockRegion || settings.bedrockModelDiscovery === false || discoveryTimer)
    return stop;
  const refresh = () =>
    discoverBedrockModels(settings).then(setBedrockDiscoveredModels, (error: unknown) =>
      options.onError?.(error),
    );
  discoveryTimer = setInterval(refresh, 15 * 60_000);
  discoveryTimer.unref?.();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    refresh(),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, options.startupTimeoutMs ?? 10_000);
      timeout.unref?.();
    }),
  ]);
  clearTimeout(timeout);
  return stop;
}
