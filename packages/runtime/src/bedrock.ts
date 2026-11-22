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
 * deployment configured an attribution role). Without a subject the
 * deployment's own identity is used.
 */
export function withBedrockCaller<T>(subjectId: string | null | undefined, fn: () => T): T {
  return subjectId ? callers.run({ subjectId }, fn) : fn();
}

/**
 * The STS session name for a person: `og-` and their stable user id, or a
 * digest of it when the id does not fit STS's 64-character name charset.
 * Never an email address.
 */
export function bedrockSessionName(subjectId: string): string {
  return /^[\w+=,.@-]{1,61}$/u.test(subjectId) && !subjectId.includes("@")
    ? `og-${subjectId}`
    : `og-${createHash("sha256").update(subjectId).digest("hex").slice(0, 40)}`;
}

const SESSION_LIMIT = 2_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const attributedSessions = new Map<
  string,
  { credentials?: AwsCredentials; pending?: Promise<AwsCredentials> }
>();

function xmlField(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([^<]*)</${name}>`, "u").exec(xml)?.[1];
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
  const response = await fetchImpl(url, { method: "POST", headers, body });
  const xml = await response.text();
  const accessKeyId = xmlField(xml, "AccessKeyId");
  const secretAccessKey = xmlField(xml, "SecretAccessKey");
  const sessionToken = xmlField(xml, "SessionToken");
  const expiration = xmlField(xml, "Expiration");
  if (!response.ok || !accessKeyId || !secretAccessKey || !sessionToken)
    throw new Error(
      `Amazon Bedrock attribution could not assume ${roleArn} (${xmlField(xml, "Code") ?? `HTTP ${response.status}`}). Check the role's trust policy (docs/amazon-bedrock.md).`,
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
          message: awsType ? `${awsType}: ${message}` : message,
        },
      });
    }
  } catch {
    // Not JSON: pass it on unchanged; the transport keeps only its status.
  }
  headers.delete("content-length");
  return new Response(body, { status: response.status, headers });
}

/** Bedrock routes that refused an Anthropic beta header or a forced tool choice. */
const withoutBetas = new Set<string>();
const withoutForcedTools = new Set<string>();

/** Test seam: forget remembered Bedrock request fallbacks. */
export function resetBedrockFallbacksForTests() {
  withoutBetas.clear();
  withoutForcedTools.clear();
}

type Json = Record<string, any>;

function dropBetas(headers: Headers, body: Json): void {
  headers.delete("anthropic-beta");
  // Prefix-bound thinking controls exist only under their beta.
  if (body.thinking && typeof body.thinking === "object") delete body.thinking.block_binding;
}

function dropForcedTool(body: Json): void {
  const choice = body.tool_choice;
  if (choice?.type === "any" || choice?.type === "tool") {
    body.tool_choice = {
      type: "auto",
      ...(choice.disable_parallel_tool_use === undefined
        ? {}
        : { disable_parallel_tool_use: choice.disable_parallel_tool_use }),
    };
  }
}

/**
 * The fetch an AnthropicMessagesModel uses on a Bedrock route: drops the
 * Anthropic credentials, signs with SigV4 and, if Bedrock refuses a beta
 * header or a forced tool choice, sends the request once more without it and
 * leaves it out on this route from then on.
 */
export function bedrockFetch(
  provider: ResolvedModelProvider,
  inner: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const bedrock = provider.bedrock;
  if (!bedrock) throw new Error(`${provider.id} is not an Amazon Bedrock provider`);
  const routeKey = `${provider.id}\0${provider.baseUrl ?? ""}`;
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
    const url = new URL(input instanceof Request ? input.url : String(input));
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
    if (parsed && withoutBetas.has(routeKey)) dropBetas(headers, parsed);
    if (parsed && withoutForcedTools.has(routeKey)) dropForcedTool(parsed);
    let body = parsed ? JSON.stringify(parsed) : (init?.body as string | undefined);
    let response = await send(url, init, headers, body);
    if (response.ok) return anthropicShaped(response);
    const text = await response.text();
    if (response.status === 400 && parsed) {
      const betaRefused = headers.has("anthropic-beta") && /beta/iu.test(text);
      const forcedChoice =
        parsed.tool_choice?.type === "any" || parsed.tool_choice?.type === "tool";
      const toolChoiceRefused = !betaRefused && forcedChoice && /tool_choice/iu.test(text);
      if (betaRefused || toolChoiceRefused) {
        if (betaRefused) {
          withoutBetas.add(routeKey);
          dropBetas(headers, parsed);
        } else {
          withoutForcedTools.add(routeKey);
          dropForcedTool(parsed);
        }
        body = JSON.stringify(parsed);
        response = await send(url, init, headers, body);
        if (response.ok) return anthropicShaped(response);
        return anthropicShaped(response, await response.text());
      }
    }
    return anthropicShaped(response, text);
  };
  return wrapped as typeof globalThis.fetch;
}

const GEOS: [RegExp, string][] = [
  [/^eu-/u, "eu"],
  [/^us-gov-/u, "us-gov"],
  [/^us-/u, "us"],
  [/^ap-/u, "apac"],
  [/^ca-/u, "ca"],
];

/**
 * The system profile or model id an application profile copies, read from
 * the regions of the foundation models it lists: one region is in-Region,
 * several in one geography are that geography's profile, and a model ARN
 * without a region (or regions in several geographies) is global.
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
  return geos.size === 1 ? `${[...geos][0]}.${modelId}` : `global.${modelId}`;
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
 * previous list and is reported through `onError`.
 */
export async function startBedrockModelDiscovery(
  settings: Pick<Settings, "bedrockRegion" | "bedrockModelDiscovery">,
  options: { onError?: (error: unknown) => void; startupTimeoutMs?: number } = {},
): Promise<void> {
  if (!settings.bedrockRegion || settings.bedrockModelDiscovery === false || discoveryTimer)
    return;
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
}
