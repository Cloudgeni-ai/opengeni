#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  CanaryReceiptStore,
  canaryResponseHeaders,
  withCanaryReadSignal,
} from "./canary-publication-receipts";
import { confirmCanaryCohort, readRegistryPackage, workflowCanarySequence } from "./publish-canary";
import {
  acknowledgedPlan,
  archiveManifest,
  array,
  equal,
  hash,
  integer,
  json,
  MiB,
  object,
  positiveId,
  publisherZip,
  PUBLISHER_PATH,
  RECOVERY_PATH,
  REPOSITORY,
  REPOSITORY_URL,
  requireThat,
  sha,
  signedPolicy,
  sourceCohort,
  SLSA,
  text,
  type JsonObject,
  type Origin,
  type SourcePackage,
} from "./canary-reconciliation-inputs";

export type Controller = { source: string; runId: string; attempt: string };
export type FileReference = { file: string; bytes: number; sha256: string };
const REGISTRY = "https://registry.npmjs.org";
const API = `https://api.github.com/repos/${REPOSITORY}`;
export const RECOVERY_LIMITS = Object.freeze({
  deadlineMs: 900_000,
  requestMs: 30_000,
  extraGets: 200,
  outputBytes: 768 * MiB,
  providerBytes: 16 * MiB,
  zipBytes: 80 * MiB,
  archiveBytes: 512 * MiB,
  attestationBytes: 64 * MiB,
  recordBytes: 8 * MiB,
  files: 8192,
});

export function admitController(
  env: Record<string, string | undefined>,
  actualHead: string,
): { controller: Controller; originInput: Omit<Origin, "tree"> } {
  const source = sha(env.SOURCE_SHA),
    controllerSource = sha(env.GITHUB_SHA);
  requireThat(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REPOSITORY === REPOSITORY &&
      env.GITHUB_SERVER_URL === "https://github.com" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_WORKFLOW_SHA === controllerSource &&
      env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${RECOVERY_PATH}@refs/heads/main` &&
      controllerSource === actualHead &&
      env.GH_TOKEN &&
      !env.NODE_AUTH_TOKEN &&
      !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    "Recovery requires its own protected GET-only controller",
  );
  const runId = positiveId(env.PUBLISHER_RUN_ID),
    attempt = positiveId(env.PUBLISHER_ATTEMPT);
  const controller = {
    source: controllerSource,
    runId: positiveId(env.GITHUB_RUN_ID),
    attempt: positiveId(env.GITHUB_RUN_ATTEMPT),
  };
  workflowCanarySequence(runId, attempt);
  workflowCanarySequence(controller.runId, controller.attempt);
  requireThat(runId !== controller.runId, "Recovery cannot observe its own publication");
  return { controller, originInput: { source, runId, attempt } };
}

export function admitFailedPublisher(
  run: unknown,
  jobs: unknown,
  artifactList: unknown,
  origin: Origin,
): JsonObject {
  const value = object(run);
  requireThat(
    String(value.id) === origin.runId &&
      String(value.run_attempt) === origin.attempt &&
      value.head_sha === origin.source &&
      value.head_branch === "main" &&
      value.path === PUBLISHER_PATH &&
      value.event === "workflow_dispatch" &&
      value.status === "completed" &&
      value.conclusion === "failure" &&
      object(value.repository).full_name === REPOSITORY &&
      object(value.head_repository).full_name === REPOSITORY &&
      object(value.repository).id === object(value.head_repository).id &&
      value.html_url === `${REPOSITORY_URL}/actions/runs/${origin.runId}`,
    "Publisher provider identity differs",
  );
  const listed = object(jobs),
    rows = array(listed.jobs);
  requireThat(
    listed.total_count === rows.length && rows.length === 1,
    "Publisher job inventory differs",
  );
  const job = object(rows[0]);
  requireThat(
    job.name === "Publish canary.N" &&
      job.status === "completed" &&
      job.conclusion === "failure" &&
      String(job.run_id) === origin.runId &&
      String(job.run_attempt) === origin.attempt &&
      job.head_sha === origin.source,
    "Publisher job differs",
  );
  const steps = array(job.steps).map(object);
  const publish = steps.findIndex((s) => s.name === "Publish canary versions");
  const site = steps.findIndex(
    (s) => s.name === "Retain exact Site package pins for this deployment",
  );
  const receipts = steps.findIndex(
    (s) => s.name === "Retain bounded publication and registry receipts",
  );
  requireThat(
    publish > 0 &&
      site === publish + 1 &&
      receipts === site + 1 &&
      steps[publish]?.conclusion === "failure" &&
      steps[site]?.conclusion === "skipped" &&
      steps[receipts]?.conclusion === "success" &&
      steps.slice(0, publish).every((s) => s.conclusion === "success") &&
      steps.filter((s) => s.conclusion === "failure").length === 1 &&
      steps
        .slice(receipts + 1)
        .every((s) => s.conclusion === "success" || s.conclusion === "skipped"),
    "Unsupported publisher failure pattern",
  );
  const artifacts = object(artifactList),
    all = array(artifacts.artifacts).map(object);
  requireThat(
    artifacts.total_count === all.length &&
      all.length <= 100 &&
      !all.some((a) => a.name === `site-package-versions-${origin.source}`),
    "Publisher Site delivery is not absent",
  );
  const matches = all.filter((a) => a.name === `canary-publication-receipts-${origin.source}`);
  requireThat(matches.length === 1, "Publisher receipt artifact absent or ambiguous");
  const artifact = matches[0]!,
    workflow = object(artifact.workflow_run);
  requireThat(
    artifact.expired === false &&
      /^sha256:[a-f0-9]{64}$/.test(text(artifact.digest)) &&
      String(workflow.id) === origin.runId &&
      workflow.head_sha === origin.source &&
      workflow.head_branch === "main" &&
      workflow.repository_id === object(value.repository).id &&
      workflow.head_repository_id === object(value.repository).id,
    "Receipt artifact identity differs",
  );
  integer(artifact.id, 1, Number.MAX_SAFE_INTEGER);
  integer(artifact.size_in_bytes, 1, RECOVERY_LIMITS.zipBytes);
  return artifact;
}

function writeAll(fd: number, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    requireThat(count > 0, "Custody write did not advance");
    offset += count;
  }
}
function syncDirectory(directory: string) {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** New evidence always names both its observer and the unchanged failed origin. */
export class RecoveryStore {
  private ordinal = 0;
  private bytes = 0;
  private cacheBytes = 0;
  constructor(
    readonly directory: string,
    readonly controller: Controller,
    readonly origin: Origin,
  ) {
    this.controller = Object.freeze({ ...controller });
    this.origin = Object.freeze({ ...origin });
    mkdirSync(directory, { mode: 0o700 });
    syncDirectory(resolve(directory, ".."));
    syncDirectory(directory);
  }
  path(ref: FileReference) {
    return join(this.directory, ref.file);
  }
  remainingCacheBytes() {
    return 64 * MiB - this.cacheBytes;
  }
  chargeCache(count: number) {
    requireThat(
      count <= this.remainingCacheBytes() && count <= RECOVERY_LIMITS.outputBytes - this.bytes,
      "Verifier cohort cache quota exhausted",
    );
    this.cacheBytes += count;
    this.bytes += count;
  }
  file(bytes: Buffer, extension = "json"): FileReference {
    requireThat(
      bytes.length <= RECOVERY_LIMITS.outputBytes - this.bytes &&
        this.ordinal < RECOVERY_LIMITS.files,
      "Recovery output quota exhausted",
    );
    const file = `${String(this.ordinal++).padStart(4, "0")}.${extension}`,
      path = join(this.directory, file),
      fd = openSync(path, "wx", 0o600);
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.bytes += bytes.length;
    syncDirectory(this.directory);
    const actual = readFileSync(path);
    requireThat(actual.equals(bytes), "Recovery custody readback differs");
    return { file, bytes: bytes.length, sha256: hash(bytes) };
  }
  record(kind: string, fields: JsonObject = {}): FileReference {
    requireThat(
      !["schema", "origin", "controller", "kind", "recordedAt"].some((key) =>
        Object.hasOwn(fields, key),
      ),
      "Cannot overwrite recovery identity",
    );
    const bytes = Buffer.from(
      JSON.stringify(
        {
          schema: "opengeni.canary-reconciliation.v1",
          kind,
          origin: this.origin,
          controller: this.controller,
          recordedAt: new Date().toISOString(),
          ...fields,
        },
        null,
        2,
      ) + "\n",
    );
    requireThat(bytes.length <= RECOVERY_LIMITS.recordBytes, "Recovery record outside bound");
    return this.file(bytes);
  }
  stream(extension: string, cap: number) {
    requireThat(this.ordinal < RECOVERY_LIMITS.files, "Recovery file quota exhausted");
    const file = `${String(this.ordinal++).padStart(4, "0")}.${extension}`,
      path = join(this.directory, file);
    const fd = openSync(path, "wx", 0o600);
    syncDirectory(this.directory);
    let retained = 0,
      closed = false;
    return {
      append: (part: Buffer) => {
        requireThat(!closed, "Closed recovery stream");
        const prefix = part.subarray(
          0,
          Math.max(0, Math.min(cap - retained, RECOVERY_LIMITS.outputBytes - this.bytes)),
        );
        writeAll(fd, prefix);
        retained += prefix.length;
        this.bytes += prefix.length;
        fsyncSync(fd);
        return prefix.length === part.length;
      },
      close: (): { bytes: Buffer; reference: FileReference } => {
        requireThat(!closed, "Recovery stream closed twice");
        fsyncSync(fd);
        closeSync(fd);
        closed = true;
        syncDirectory(this.directory);
        const bytes = readFileSync(path);
        requireThat(bytes.length === retained, "Stream readback differs");
        return { bytes, reference: { file, bytes: retained, sha256: hash(bytes) } };
      },
    };
  }
  async body(
    response: Response,
    label: string,
    cap: number,
    signal: AbortSignal,
    receivedBytes: (count: number) => void,
  ): Promise<{ bytes: Buffer; reference: FileReference }> {
    const headers = this.record("GET_RESPONSE", {
      label,
      status: response.status,
      headers: canaryResponseHeaders(response.headers),
    });
    requireThat(this.ordinal < RECOVERY_LIMITS.files, "Recovery file quota exhausted");
    const file = `${String(this.ordinal++).padStart(4, "0")}.body`,
      fd = openSync(join(this.directory, file), "wx", 0o600);
    const reader = response.body?.getReader(),
      chunks: Buffer[] = [];
    let retained = 0,
      received = 0,
      complete = false,
      failure = false;
    try {
      if (reader)
        while (true) {
          const part = await withCanaryReadSignal(reader.read(), signal);
          if (part.done) break;
          received += part.value.byteLength;
          receivedBytes(part.value.byteLength);
          const bytes = Buffer.from(part.value).subarray(
            0,
            Math.max(0, Math.min(cap - retained, RECOVERY_LIMITS.outputBytes - this.bytes)),
          );
          writeAll(fd, bytes);
          chunks.push(bytes);
          retained += bytes.length;
          this.bytes += bytes.length;
          requireThat(received === retained, "GET body quota exhausted");
        }
      complete = true;
    } catch {
      failure = true;
      if (reader) void reader.cancel().catch(() => {});
    } finally {
      fsyncSync(fd);
      closeSync(fd);
      syncDirectory(this.directory);
      reader?.releaseLock();
    }
    const bytes = Buffer.concat(chunks),
      actual = readFileSync(join(this.directory, file));
    requireThat(actual.equals(bytes), "GET prefix readback differs");
    const reference = { file, bytes: bytes.length, sha256: hash(bytes) };
    this.record("GET_BODY_CLOSED", {
      label,
      headers,
      body: reference,
      received,
      retained,
      complete,
      failure,
    });
    requireThat(!failure && complete, "GET failed; closed prefix retained");
    return { bytes, reference };
  }
}

type RecoveryRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ExtraKind = "provider" | "zip" | "archive" | "attestation" | "selected";
export class RecoveryGets {
  readonly deadline: number;
  private count = 0;
  private failed = false;
  private used = { provider: 0, zip: 0, archive: 0, attestation: 0, selected: 0 };
  private labels = new Set<string>();
  constructor(
    private readonly store: RecoveryStore,
    private readonly request: RecoveryRequest,
    private readonly token: string,
    private readonly now = () => performance.now(),
    private readonly requestMs: number = RECOVERY_LIMITS.requestMs,
  ) {
    integer(requestMs, 1, RECOVERY_LIMITS.requestMs);
    this.deadline = now() + RECOVERY_LIMITS.deadlineMs;
  }
  remaining() {
    return this.deadline - this.now();
  }
  counters() {
    return { actualGets: this.count, responseBytes: { ...this.used } };
  }
  async get(
    url: string,
    label: string,
    kind: ExtraKind,
    cap: number,
  ): Promise<{ bytes: Buffer; reference: FileReference; status: number; location: string | null }> {
    const parsed = new URL(url);
    requireThat(
      !this.failed &&
        !this.labels.has(label) &&
        this.count < RECOVERY_LIMITS.extraGets &&
        this.remaining() > 0,
      "Recovery GET admission closed",
    );
    const provider =
      parsed.origin === "https://api.github.com" &&
      parsed.pathname.startsWith(`/repos/${REPOSITORY}/`);
    const registry = parsed.origin === REGISTRY && !parsed.search;
    const artifact =
      kind === "zip" &&
      parsed.protocol === "https:" &&
      (/^productionresultssa[a-z0-9]+\.blob\.core\.windows\.net$/.test(parsed.hostname) ||
        /^[a-z0-9.-]+\.actions\.githubusercontent\.com$/.test(parsed.hostname));
    requireThat(
      !parsed.username &&
        !parsed.password &&
        !parsed.hash &&
        ((kind === "provider" && provider) ||
          (kind === "zip" && (provider || artifact)) ||
          ((kind === "archive" || kind === "attestation" || kind === "selected") && registry)),
      "Untrusted GET destination",
    );
    const ceilings = {
      provider: RECOVERY_LIMITS.providerBytes,
      zip: RECOVERY_LIMITS.zipBytes,
      archive: RECOVERY_LIMITS.archiveBytes,
      attestation: RECOVERY_LIMITS.attestationBytes,
      selected: 64 * MiB,
    };
    const available = Math.min(cap, ceilings[kind] - this.used[kind]);
    requireThat(available > 0, "Recovery GET byte quota exhausted");
    this.labels.add(label);
    this.count++;
    // Signed artifact redirect queries and credentials never enter logs/receipts.
    this.store.record("GET_INTENT", {
      label,
      budgetClass: kind,
      method: "GET",
      endpointSha256: hash(parsed.origin + parsed.pathname),
      ordinal: this.count,
      maximumBodyBytes: available,
    });
    const signal = AbortSignal.timeout(
      Math.max(1, Math.ceil(Math.min(this.requestMs, this.remaining()))),
    );
    try {
      const response = await withCanaryReadSignal(
        this.request(url, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal,
          headers: {
            accept:
              !provider && (kind === "zip" || kind === "archive")
                ? "application/octet-stream"
                : "application/json",
            ...(provider
              ? { authorization: `Bearer ${this.token}`, "x-github-api-version": "2022-11-28" }
              : {}),
          },
        }),
        signal,
      );
      const retained = await this.store.body(response, label, available, signal, (count) => {
        this.used[kind] += count;
      });
      requireThat(this.remaining() > 0, "Recovery stage deadline exceeded");
      requireThat(
        response.status === 200 || (kind === "zip" && provider && response.status === 302),
        "GET returned unsupported status",
      );
      return { ...retained, status: response.status, location: response.headers.get("location") };
    } catch {
      this.failed = true;
      this.store.record("GET_FAILED", { label, noRetry: true });
      throw new Error("Recovery GET failed; no retry");
    }
  }
  async provider(path: string, label: string): Promise<unknown> {
    const result = await this.get(API + path, label, "provider", 2 * MiB);
    requireThat(result.status === 200, "Provider GET did not return 200");
    return json(result.bytes);
  }
}

function git(root: string, args: string[], cap = 2 * MiB): Buffer {
  const result = spawnSync("git", args, {
    cwd: root,
    timeout: 10_000,
    maxBuffer: cap,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
  requireThat(
    result.status === 0 && !result.signal && !result.error && result.stderr.length === 0,
    "Immutable source read failed",
  );
  return result.stdout;
}
export function historicalCohort(
  root: string,
  source: string,
  controller: string,
): {
  tree: string;
  packages: SourcePackage[];
  sourceFiles: { gitPath: string; bytes: number; sha256: string }[];
} {
  sha(source);
  sha(controller);
  git(root, ["merge-base", "--is-ancestor", source, controller]);
  // Reject unknown historical producer protocols instead of executing them.
  for (const path of [
    PUBLISHER_PATH,
    "scripts/publish-canary.ts",
    "scripts/canary-publication-receipts.ts",
    "scripts/publishable-workspaces.ts",
  ]) {
    equal(
      git(root, ["show", `${source}:${path}`]),
      git(root, ["show", `${controller}:${path}`]),
      "Historical publisher protocol unsupported",
    );
  }
  const tree = sha(
    git(root, ["rev-parse", `${source}^{tree}`])
      .toString()
      .trim(),
  );
  const paths = git(root, ["ls-tree", "-r", "--name-only", source])
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(
      (path) =>
        path === "package.json" ||
        path === ".changeset/config.json" ||
        /^(apps|packages)\/[^/]+\/package\.json$/.test(path),
    );
  requireThat(paths.length <= 128, "Source manifest inventory outside bound");
  const files = new Map(
    paths.map((path) => [path, git(root, ["show", `${source}:${path}`], 64 * 1024)]),
  );
  return {
    tree,
    packages: sourceCohort(files),
    sourceFiles: [...files].map(([gitPath, bytes]) => ({
      gitPath,
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
  };
}

export function signatureArguments(
  archivePath: string,
  bundlePath: string,
  origin: Origin,
): string[] {
  return [
    "attestation",
    "verify",
    archivePath,
    "--bundle",
    bundlePath,
    "--repo",
    REPOSITORY,
    "--cert-identity",
    `${REPOSITORY_URL}/${PUBLISHER_PATH}@refs/heads/main`,
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--signer-digest",
    origin.source,
    "--source-digest",
    origin.source,
    "--source-ref",
    "refs/heads/main",
    "--deny-self-hosted-runners",
    "--predicate-type",
    SLSA,
    "--digest-alg",
    "sha512",
    "--format",
    "json",
  ];
}

/** Only the owned verifier child may be killed; candidate/package code never runs. */
export async function verifySignature(
  store: RecoveryStore,
  origin: Origin,
  archive: FileReference,
  bundle: FileReference,
  remainingMs: number,
): Promise<unknown> {
  requireThat(remainingMs > 0, "Signature stage deadline exhausted");
  // The Ubuntu runner's root-owned official CLI is outside the checkout and
  // dependency bins; never resolve a verifier supplied through package PATH.
  const executable = "/usr/bin/gh",
    tool = lstatSync(executable);
  requireThat(
    process.platform === "linux" &&
      realpathSync(executable) === executable &&
      tool.isFile() &&
      tool.uid === 0 &&
      (tool.mode & 0o022) === 0 &&
      tool.size > 0 &&
      tool.size <= 64 * MiB,
    "Official runner GitHub CLI is unavailable or writable",
  );
  const toolBytes = readFileSync(executable);
  requireThat(toolBytes.length === tool.size, "Verifier tool changed");
  const config = join(store.directory, `gh-${archive.file}`);
  mkdirSync(config, { mode: 0o700 });
  syncDirectory(store.directory);
  const args = signatureArguments(store.path(archive), store.path(bundle), origin);
  const environment = {
    PATH: process.env.PATH,
    GH_CONFIG_DIR: config,
    XDG_CACHE_HOME: config,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    LANG: "C.UTF-8",
  };
  const intent = store.record("SIGNATURE_VERIFY_INTENT", {
    executable,
    executableBytes: toolBytes.length,
    executableSha256: hash(toolBytes),
    args,
    environment: { ...environment, PATH: "RUNNER_PATH" },
    timeoutMs: Math.min(60_000, remainingMs),
    trust: "OFFICIAL_GH_PUBLIC_GOOD_TUF_DEFAULTS",
    tufNetworkBytes: "STANDARD_GH_TRUST_FETCHES_OUTSIDE_CONTROLLED_GET_BYTE_QUOTAS",
  });
  const stdout = store.stream("stdout", 4 * MiB),
    stderr = store.stream("stderr", MiB);
  const child = spawn(executable, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let timedOut = false,
    exceeded = false,
    launchError = false,
    streamError = false,
    cacheExceeded = false;
  const cache = (): number => {
    let entriesSeen = 0;
    const visit = (directory: string, depth: number): number => {
      requireThat(depth < 8, "Verifier cache depth outside bound");
      return readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => {
        entriesSeen++;
        requireThat(entriesSeen <= 2048, "Verifier cache file count outside bound");
        const path = join(directory, entry.name),
          stat = lstatSync(path);
        requireThat(!stat.isSymbolicLink(), "Verifier cache link rejected");
        if (stat.isDirectory()) return sum + visit(path, depth + 1);
        requireThat(stat.isFile(), "Verifier cache special file rejected");
        return sum + stat.size;
      }, 0);
    };
    return visit(config, 0);
  };
  const stop = () => {
    if (child.pid) child.kill("SIGKILL");
  };
  const timer = setTimeout(
    () => {
      timedOut = true;
      stop();
    },
    Math.max(1, Math.ceil(Math.min(60_000, remainingMs))),
  );
  const cacheTimer = setInterval(() => {
    try {
      if (cache() > Math.min(16 * MiB, store.remainingCacheBytes())) {
        cacheExceeded = true;
        stop();
      }
    } catch {
      cacheExceeded = true;
      stop();
    }
  }, 100);
  child.stdout.on("data", (part: Buffer) => {
    try {
      if (!stdout.append(part)) {
        exceeded = true;
        stop();
      }
    } catch {
      streamError = true;
      stop();
    }
  });
  child.stderr.on("data", (part: Buffer) => {
    try {
      if (!stderr.append(part)) {
        exceeded = true;
        stop();
      }
    } catch {
      streamError = true;
      stop();
    }
  });
  child.on("error", () => {
    launchError = true;
  });
  const terminal = await new Promise<{ exit: number | null; signal: string | null }>((done) =>
    child.once("close", (exit, signal) => done({ exit, signal })),
  );
  clearTimeout(timer);
  clearInterval(cacheTimer);
  const out = stdout.close(),
    err = stderr.close();
  let cacheBytes = 0;
  try {
    cacheBytes = cache();
    store.chargeCache(cacheBytes);
    if (cacheBytes > 16 * MiB) cacheExceeded = true;
  } catch {
    cacheExceeded = true;
  }
  store.record("SIGNATURE_VERIFY_CLOSED", {
    intent,
    stdout: out.reference,
    stderr: err.reference,
    ...terminal,
    timedOut,
    exceeded,
    launchError,
    streamError,
    cacheExceeded,
    cacheBytes,
    stdioClosed: true,
    cacheBoundIsMonitoredAndRecheckedAfterClose: true,
  });
  requireThat(
    terminal.exit === 0 &&
      terminal.signal === null &&
      !timedOut &&
      !exceeded &&
      !launchError &&
      !streamError &&
      !cacheExceeded,
    "Official signature verification failed",
  );
  return json(out.bytes);
}

type ReconciliationOptions = {
  origin: Origin;
  controller: Controller;
  packages: readonly SourcePackage[];
  members: ReadonlyMap<string, Buffer>;
  artifact: JsonObject;
  store: RecoveryStore;
  gets: RecoveryGets;
  request?: RecoveryRequest;
  verify?: typeof verifySignature;
  poll?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    maxReads?: number;
  };
};
class RecoveryMetadataStore extends CanaryReceiptStore {
  constructor(
    directory: string,
    controller: Controller,
    private readonly failedOrigin: Origin,
  ) {
    super(directory, {
      source: controller.source,
      workflowSource: controller.source,
      runId: controller.runId,
      attempt: controller.attempt,
    });
  }
  override record(kind: string, fields: JsonObject) {
    return super.record(kind, { ...fields, failedOrigin: this.failedOrigin });
  }
}
export async function reconcileAcknowledgedCanaries(
  options: ReconciliationOptions,
): Promise<JsonObject> {
  const { origin, controller, store, gets } = options;
  const plan = acknowledgedPlan(options.members, origin, options.packages);
  store.record("ORIGIN_RECEIPTS_ADMITTED", {
    artifact: options.artifact,
    planSha256: plan.planSha256,
    inventory: plan.inventory,
    publisherConclusion: "failure",
    providerSiteArtifact: "absent",
  });
  const custody = new RecoveryMetadataStore(join(store.directory, "metadata"), controller, origin);
  const manifests = new Map<string, JsonObject>(),
    request = options.request ?? fetch;
  let metadataGets = 0;
  const read: typeof readRegistryPackage = async (name, _request, base, readOptions = {}) => {
    const pkg = plan.packages.find((item) => item.name === name);
    requireThat(pkg, "Unadmitted receipt package");
    requireThat(gets.remaining() > 0, "Recovery receipt deadline exhausted");
    const signal = AbortSignal.any([
      readOptions.signal ?? AbortSignal.timeout(10_000),
      AbortSignal.timeout(Math.max(1, Math.ceil(gets.remaining()))),
    ]);
    return readRegistryPackage(
      name,
      async (input, init) => {
        requireThat(
          init?.method === "GET" && gets.remaining() > 0 && metadataGets < 256,
          "Receipt GET deadline or quota exhausted",
        );
        metadataGets++;
        const response = await request(input, init);
        // Let the existing receipt store retain headers/body before parsing.
        return response;
      },
      base,
      { ...readOptions, signal, custody },
    );
  };
  // Signed bytes have their own finite GET/body quotas. The ordinary metadata
  // phase runs afterward, so its 180s window includes its complete final pass.
  const audited: JsonObject[] = [],
    budget = { tarBytes: 0, regularBytes: 0 };
  for (let index = 0; index < plan.packages.length; index++) {
    const pkg = plan.packages[index]!;
    const selected = await gets.get(
      `${REGISTRY}/${encodeURIComponent(pkg.name)}/${pkg.version}`,
      `signed-metadata-${index}`,
      "selected",
      2 * MiB,
    );
    requireThat(selected.status === 200, "Selected signature metadata missing");
    const manifest = object(json(selected.bytes)),
      dist = object(manifest.dist);
    requireThat(
      manifest.name === pkg.name &&
        manifest.version === pkg.version &&
        dist.integrity === pkg.integrity &&
        object(object(dist.attestations).provenance).predicateType === SLSA,
      "Selected signed package differs",
    );
    const locator = (value: unknown, expectedPath: string) => {
      const url = new URL(text(value));
      requireThat(
        url.origin === REGISTRY &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          decodeURIComponent(url.pathname) === expectedPath,
        "Untrusted package byte locator",
      );
      return url.href;
    };
    const tarUrl = locator(
      dist.tarball,
      `/${pkg.name}/-/${pkg.name.slice("@opengeni/".length)}-${pkg.version}.tgz`,
    );
    const attestationUrl = locator(
      object(dist.attestations).url,
      `/-/npm/v1/attestations/${pkg.name}@${pkg.version}`,
    );
    const archive = await gets.get(tarUrl, `archive-${index}`, "archive", 64 * MiB);
    requireThat(archive.status === 200, "Package archive missing");
    const inspection = archiveManifest(archive.bytes, pkg, budget);
    const attestations = await gets.get(
      attestationUrl,
      `attestations-${index}`,
      "attestation",
      2 * MiB,
    );
    requireThat(attestations.status === 200, "Package attestation missing");
    const attested = array(object(json(attestations.bytes)).attestations)
      .map(object)
      .filter((row) => row.predicateType === SLSA);
    requireThat(attested.length === 1, "Expected one provenance bundle");
    const bundle = object(attested[0]!.bundle),
      bundleFile = store.file(Buffer.from(JSON.stringify(bundle)));
    const verified = await (options.verify ?? verifySignature)(
      store,
      origin,
      archive.reference,
      bundleFile,
      gets.remaining(),
    );
    const signer = signedPolicy(bundle, verified, origin, pkg);
    const memberInventory = store.file(Buffer.from(JSON.stringify(inspection.members)), "members");
    manifests.set(pkg.name, inspection.manifest);
    audited.push({
      ...pkg,
      archive: archive.reference,
      metadata: selected.reference,
      attestations: attestations.reference,
      bundle: bundleFile,
      memberInventory,
      signer,
      memberCount: inspection.members.length,
    });
  }
  // The unchanged poller includes a complete final cohort reread. All metadata
  // GETs share its 180s/256-read/4-parallel limits and the one 8/64/80MiB store.
  const metadataTimeoutMs = Math.min(options.poll?.timeoutMs ?? 180_000, gets.remaining());
  const metadataSignal = AbortSignal.timeout(Math.max(1, Math.ceil(metadataTimeoutMs)));
  await confirmCanaryCohort(
    plan.packages.map((pkg) => ({ ...pkg, previousLatest: pkg.previousLatest })),
    read,
    {
      ...options.poll,
      timeoutMs: metadataTimeoutMs,
      sleep: (ms) => withCanaryReadSignal((options.poll?.sleep ?? Bun.sleep)(ms), metadataSignal),
      custody,
    },
  );
  requireThat(gets.remaining() > 0, "Recovery stage deadline exceeded");
  const pins = Object.fromEntries(
    ["@opengeni/sdk", "@opengeni/react", "@opengeni/codemode", "@opengeni/ogtool"].map((name) => {
      const pkg = plan.packages.find((entry) => entry.name === name);
      requireThat(pkg && manifests.has(name), "Complete Site cohort missing");
      return [name, pkg.version];
    }),
  );
  const result = {
    authority: "protected-get-only-reconciliation",
    source: origin.source,
    tree: origin.tree,
    publisherConclusion: "failure",
    providerSiteArtifact: "absent",
    promotionEligible: false,
    planSha256: plan.planSha256,
    packages: audited,
    sitePackageVersions: pins,
    sitePinsSha256: hash(JSON.stringify(pins)),
    controlledGets: gets.counters(),
    metadataGets,
    metadataLimits: {
      timeoutMs: 180_000,
      maxReads: 256,
      concurrentHttpReads: 4,
      responseBytes: 8 * MiB,
      bodyBytes: 64 * MiB,
      outputBytes: 80 * MiB,
    },
    archiveInspection: budget,
    signatureTrust: "OFFICIAL_GH_PUBLIC_GOOD_TUF_DEFAULTS",
    allArchivesAndProvenanceSourceBindingsVerified: true,
    tufNetworkBytes: "STANDARD_GH_TRUST_FETCHES_OUTSIDE_CONTROLLED_GET_BYTE_QUOTAS",
  };
  const resultRef = store.record("RECONCILIATION_VERIFIED", result);
  store.file(
    Buffer.from(
      JSON.stringify(
        {
          schema: "opengeni.reconciled-site-package-versions.v1",
          origin,
          controller,
          reconciliation: resultRef,
          promotionEligible: false,
          versions: pins,
        },
        null,
        2,
      ),
    ),
    "pins",
  );
  return { origin, controller, ...result };
}

export async function main() {
  const root = resolve(import.meta.dir, ".."),
    head = git(root, ["rev-parse", "HEAD"]).toString().trim();
  const { controller, originInput } = admitController(process.env, head);
  const source = historicalCohort(root, originInput.source, controller.source),
    origin = { ...originInput, tree: source.tree };
  mkdirSync(join(root, ".release"), { recursive: true });
  syncDirectory(root);
  const store = new RecoveryStore(
    join(root, ".release", "canary-reconciliation"),
    controller,
    origin,
  );
  const gets = new RecoveryGets(store, fetch, process.env.GH_TOKEN!);
  try {
    const run = await gets.provider(
      `/actions/runs/${origin.runId}/attempts/${origin.attempt}`,
      "publisher-run",
    );
    const jobs = await gets.provider(
      `/actions/runs/${origin.runId}/attempts/${origin.attempt}/jobs?per_page=100`,
      "publisher-jobs",
    );
    const artifacts = await gets.provider(
      `/actions/runs/${origin.runId}/artifacts?per_page=100`,
      "publisher-artifacts",
    );
    const artifact = admitFailedPublisher(run, jobs, artifacts, origin);
    const download = await gets.get(
      `${API}/actions/artifacts/${artifact.id}/zip`,
      "publisher-zip-location",
      "zip",
      RECOVERY_LIMITS.zipBytes,
    );
    let zip = download;
    if (download.status === 302) {
      requireThat(download.location, "Receipt ZIP location missing");
      zip = await gets.get(
        download.location,
        "publisher-zip-bytes",
        "zip",
        RECOVERY_LIMITS.zipBytes,
      );
    }
    requireThat(
      zip.status === 200 &&
        zip.bytes.length === artifact.size_in_bytes &&
        `sha256:${hash(zip.bytes)}` === artifact.digest,
      "Provider receipt ZIP digest differs",
    );
    store.record("SOURCE_DATA_ADMITTED", {
      sourceFiles: source.sourceFiles,
      artifact,
      zip: zip.reference,
    });
    const members = publisherZip(zip.bytes);
    await reconcileAcknowledgedCanaries({
      origin,
      controller,
      packages: source.packages,
      members,
      artifact,
      store,
      gets,
    });
    process.stdout.write(
      "Verified linked GET-only reconciliation; failed publisher conclusion preserved.\n",
    );
  } catch {
    store.record("RECONCILIATION_HELD", {
      publisherConclusion: "failure",
      providerSiteArtifact: "absent",
      noReplay: true,
    });
    throw new Error("Canary reconciliation held; retained evidence only, no publication retry");
  }
}
if (import.meta.main) await main();
