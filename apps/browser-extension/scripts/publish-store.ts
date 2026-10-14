// Uploads the store ZIP to the Chrome Web Store and submits it for review
// through the Chrome Web Store API v2. In GitHub Actions it authenticates
// keylessly: the job's OIDC token is exchanged through Workload Identity
// Federation for a short-lived access token of a service account that is a
// member of the Web Store publisher. Locally, CWS_ACCESS_TOKEN may be set
// instead.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PublishType = "DEFAULT_PUBLISH" | "STAGED_PUBLISH";

export interface PublishOptions {
  publisherId: string;
  itemId: string;
  version: string;
  zip: Uint8Array<ArrayBuffer>;
  accessToken: string;
  publishType: PublishType;
  cancelPending: boolean;
  fetch: FetchLike;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  uploadPollAttempts?: number;
}

export interface RevisionStatus {
  state?: string;
  distributionChannels?: { crxVersion?: string; deployPercentage?: number }[];
}

export interface ItemStatus {
  itemId?: string;
  lastAsyncUploadState?: string;
  submittedItemRevisionStatus?: RevisionStatus;
  publishedItemRevisionStatus?: RevisionStatus;
}

export type PublishOutcome =
  | { kind: "already_published"; status: ItemStatus }
  | { kind: "already_submitted"; status: ItemStatus }
  | { kind: "submitted"; status: ItemStatus };

const API = "https://chromewebstore.googleapis.com";
const PENDING_STATES = new Set(["PENDING_REVIEW", "STAGED"]);
const LIVE_STATES = new Set(["PUBLISHED", "PUBLISHED_TO_TESTERS"]);

export function revisionVersions(revision: RevisionStatus | undefined): string[] {
  return (revision?.distributionChannels ?? []).flatMap((channel) =>
    channel.crxVersion ? [channel.crxVersion] : [],
  );
}

async function call<T>(
  options: PublishOptions,
  method: string,
  url: string,
  body?: BodyInit,
  contentType?: string,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${options.accessToken}` };
  if (contentType) headers["content-type"] = contentType;
  const response = await options.fetch(url, { method, headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${url} failed with HTTP ${response.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export async function publishToStore(options: PublishOptions): Promise<PublishOutcome> {
  const log = options.log ?? ((line: string) => console.log(line));
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const item = `publishers/${options.publisherId}/items/${options.itemId}`;
  const fetchStatus = () => call<ItemStatus>(options, "GET", `${API}/v2/${item}:fetchStatus`);

  const before = await fetchStatus();
  const submitted = before.submittedItemRevisionStatus;
  const submittedVersions = revisionVersions(submitted);
  if (
    LIVE_STATES.has(before.publishedItemRevisionStatus?.state ?? "") &&
    revisionVersions(before.publishedItemRevisionStatus).includes(options.version) &&
    !PENDING_STATES.has(submitted?.state ?? "")
  ) {
    log(`Version ${options.version} is already published.`);
    return { kind: "already_published", status: before };
  }
  if (PENDING_STATES.has(submitted?.state ?? "")) {
    if (submittedVersions.includes(options.version)) {
      log(`Version ${options.version} is already submitted (${submitted?.state}).`);
      return { kind: "already_submitted", status: before };
    }
    if (!options.cancelPending) {
      throw new Error(
        `Version ${submittedVersions.join(", ") || "unknown"} is already ${submitted?.state}; ` +
          "rerun with cancel_pending to replace that submission.",
      );
    }
    log(`Cancelling pending submission of ${submittedVersions.join(", ") || "unknown"}.`);
    await call(options, "POST", `${API}/v2/${item}:cancelSubmission`);
  }

  log(`Uploading ${options.version} (${options.zip.byteLength} bytes).`);
  let upload = await call<{ uploadState?: string; crxVersion?: string }>(
    options,
    "POST",
    `${API}/upload/v2/${item}:upload`,
    options.zip,
    "application/zip",
  );
  let state = upload.uploadState;
  let crxVersion = upload.crxVersion;
  for (let attempt = 0; state === "IN_PROGRESS"; attempt += 1) {
    if (attempt >= (options.uploadPollAttempts ?? 60)) {
      throw new Error("The upload is still being processed; giving up.");
    }
    await sleep(5_000);
    const status = await fetchStatus();
    state = status.lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error(`Upload failed with state ${state ?? "unknown"}.`);
  if (crxVersion !== undefined && crxVersion !== options.version) {
    throw new Error(`The store parsed version ${crxVersion}, expected ${options.version}.`);
  }

  log(`Submitting ${options.version} for review (${options.publishType}).`);
  await call(
    options,
    "POST",
    `${API}/v2/${item}:publish`,
    JSON.stringify({ publishType: options.publishType }),
    "application/json",
  );
  const after = await fetchStatus();
  if (!revisionVersions(after.submittedItemRevisionStatus).includes(options.version)) {
    throw new Error(
      `The store does not report ${options.version} as submitted: ${JSON.stringify(after)}`,
    );
  }
  log(`Submitted ${options.version}: ${after.submittedItemRevisionStatus?.state}.`);
  return { kind: "submitted", status: after };
}

export interface FederationOptions {
  fetch: FetchLike;
  idTokenRequestUrl: string;
  idTokenRequestToken: string;
  workloadIdentityProvider: string;
  serviceAccount: string;
}

// GitHub OIDC token -> Google STS federated token -> service account access
// token scoped to the Chrome Web Store.
export async function federatedAccessToken(options: FederationOptions): Promise<string> {
  const audience = `//iam.googleapis.com/${options.workloadIdentityProvider}`;
  const idUrl = new URL(options.idTokenRequestUrl);
  idUrl.searchParams.set("audience", audience);
  const idResponse = await options.fetch(idUrl.toString(), {
    headers: { authorization: `Bearer ${options.idTokenRequestToken}` },
  });
  if (!idResponse.ok)
    throw new Error(`GitHub OIDC token request failed with HTTP ${idResponse.status}.`);
  const { value: subjectToken } = (await idResponse.json()) as { value?: string };
  if (!subjectToken) throw new Error("GitHub returned no OIDC token.");

  const stsResponse = await options.fetch("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      audience,
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      subjectToken,
    }),
  });
  if (!stsResponse.ok) {
    throw new Error(
      `Token exchange failed with HTTP ${stsResponse.status}: ${await stsResponse.text()}`,
    );
  }
  const { access_token: federatedToken } = (await stsResponse.json()) as { access_token?: string };
  if (!federatedToken) throw new Error("The token exchange returned no access token.");

  const impersonation = await options.fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(options.serviceAccount)}:generateAccessToken`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${federatedToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        scope: ["https://www.googleapis.com/auth/chromewebstore"],
        lifetime: "900s",
      }),
    },
  );
  if (!impersonation.ok) {
    throw new Error(
      `Service account impersonation failed with HTTP ${impersonation.status}: ${await impersonation.text()}`,
    );
  }
  const { accessToken } = (await impersonation.json()) as { accessToken?: string };
  if (!accessToken) throw new Error("Service account impersonation returned no access token.");
  return accessToken;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    version: string;
  };
  const zip = new Uint8Array(
    await readFile(resolve(root, "dist/opengeni-browser-extension-store.zip")),
  );
  const publishType = (process.env.CWS_PUBLISH_TYPE || "DEFAULT_PUBLISH") as PublishType;
  if (publishType !== "DEFAULT_PUBLISH" && publishType !== "STAGED_PUBLISH") {
    throw new Error(`Unsupported CWS_PUBLISH_TYPE ${publishType}.`);
  }
  const accessToken =
    process.env.CWS_ACCESS_TOKEN ||
    (await federatedAccessToken({
      fetch,
      idTokenRequestUrl: required("ACTIONS_ID_TOKEN_REQUEST_URL"),
      idTokenRequestToken: required("ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
      workloadIdentityProvider: required("CWS_WORKLOAD_IDENTITY_PROVIDER"),
      serviceAccount: required("CWS_SERVICE_ACCOUNT"),
    }));
  const outcome = await publishToStore({
    publisherId: required("CWS_PUBLISHER_ID"),
    itemId: required("CWS_ITEM_ID"),
    version: packageJson.version,
    zip,
    accessToken,
    publishType,
    cancelPending: process.env.CWS_CANCEL_PENDING === "true",
    fetch,
  });
  console.log(JSON.stringify({ outcome: outcome.kind, status: outcome.status }, null, 2));
}

if (import.meta.main) {
  await main();
}
