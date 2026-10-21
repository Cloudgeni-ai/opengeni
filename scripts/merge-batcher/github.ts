import { createSign } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { admit, type Comment, type PullInput, type ReadyEvent } from "./evidence";
import { type Config, type Manifest, type Outcome, type Pull, type Run } from "./model";

type Json = Record<string, any>; // Wire JSON is checked at the adapter boundary, not trusted as domain state.
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
  ) {
    super(`GitHub ${operation} failed (${status}); response body suppressed`);
  }
}
export class GitHubAuth {
  private cached: { token: string; expires: number } | null = null;
  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async token(): Promise<string> {
    if (this.env.GH_TOKEN) return this.env.GH_TOKEN;
    if (this.env.GITHUB_TOKEN) return this.env.GITHUB_TOKEN;
    if (this.cached && this.cached.expires > Date.now() + 60_000) return this.cached.token;
    const {
      GITHUB_APP_ID: app,
      GITHUB_APP_INSTALLATION_ID: installation,
      GITHUB_APP_PRIVATE_KEY: key,
    } = this.env;
    if (!app || !installation || !key) return "";
    if (!/^\d+$/.test(app) || !/^\d+$/.test(installation))
      throw new Error("Invalid GitHub App configuration");
    const now = Math.floor(Date.now() / 1000);
    const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const message = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: app })}`;
    const signature = createSign("RSA-SHA256").update(message).sign(key, "base64url");
    // Authentication only; repository mutation permissions are NOT requested in shadow.
    const permissions =
      this.env.BATCHER_MODE === "active"
        ? { contents: "write", actions: "write", pull_requests: "write", issues: "write" }
        : { contents: "read", actions: "read", pull_requests: "read", issues: "read" };
    const response = await this.transport(
      `https://api.github.com/app/installations/${installation}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${message}.${signature}`,
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ permissions }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new ProviderError(response.status, "App authentication");
    const data = (await response.json()) as Json;
    if (typeof data.token !== "string" || !Number.isFinite(Date.parse(data.expires_at)))
      throw new Error("Invalid App token response");
    this.cached = { token: data.token, expires: Date.parse(data.expires_at) };
    return this.cached.token;
  }
  async gitEnv(): Promise<Record<string, string>> {
    const token = await this.token();
    return token
      ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        }
      : {};
  }
}

// Only GET and GraphQL query operations exist on this class. The shadow runner
// receives this read adapter, never the mutation adapter.
export class GitHubReader {
  constructor(
    readonly config: Config,
    readonly auth: GitHubAuth,
    readonly transport: typeof fetch = fetch,
  ) {}
  async get(path: string): Promise<Json | Json[]> {
    const token = await this.auth.token();
    const response = await this.transport(
      `https://api.github.com/repos/${this.config.repository}/${path}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new ProviderError(response.status, "read");
    return response.json() as Promise<Json | Json[]>;
  }
  async pages(path: string, key?: string): Promise<Json[]> {
    const all: Json[] = [];
    for (let page = 1; page <= 1000; page++) {
      const data = await this.get(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const list: unknown = key ? (data as Json)[key] : data;
      if (!Array.isArray(list)) throw new Error("Malformed GitHub page");
      all.push(...list);
      if (list.length < 100) return all;
    }
    throw new Error("GitHub pagination incomplete; refusing partial observation");
  }
  async timeline(number: number): Promise<ReadyEvent[]> {
    const [owner, name] = this.config.repository.split("/");
    const events: ReadyEvent[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const token = await this.auth.token();
      const response = await this.transport("https://api.github.com/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query ReadyTimeline($owner:String!,$name:String!,$number:Int!,$cursor:String) {
            repository(owner:$owner,name:$name) {
              pullRequest(number:$number) {
                timelineItems(first:100,after:$cursor,itemTypes:[AUTO_MERGE_ENABLED_EVENT,AUTO_MERGE_DISABLED_EVENT,LABELED_EVENT,UNLABELED_EVENT]) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    __typename
                    ... on AutoMergeEnabledEvent { id createdAt }
                    ... on AutoMergeDisabledEvent { id createdAt }
                    ... on LabeledEvent { id createdAt label { name } }
                    ... on UnlabeledEvent { id createdAt label { name } }
                  }
                }
              }
            }
          }`,
          variables: { owner, name, number, cursor },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new ProviderError(response.status, "ready timeline");
      const data = (await response.json()) as Json;
      const timeline = data.data?.repository?.pullRequest?.timelineItems;
      if (data.errors || !timeline?.nodes || !timeline.pageInfo)
        throw new Error("Ready-event timeline unavailable");
      for (const node of timeline.nodes as Json[]) {
        const kind = node.__typename as string;
        if (kind === "AutoMergeEnabledEvent" || kind === "AutoMergeDisabledEvent")
          events.push({
            id: node.id,
            at: node.createdAt,
            source: "auto-merge",
            enabled: kind === "AutoMergeEnabledEvent",
          });
        if (
          (kind === "LabeledEvent" || kind === "UnlabeledEvent") &&
          node.label?.name === "queue-ready"
        )
          events.push({
            id: node.id,
            at: node.createdAt,
            source: "queue-ready",
            enabled: kind === "LabeledEvent",
          });
      }
      if (!timeline.pageInfo.hasNextPage) return events;
      if (typeof timeline.pageInfo.endCursor !== "string" || timeline.pageInfo.endCursor === cursor)
        throw new Error("Timeline pagination stalled");
      cursor = timeline.pageInfo.endCursor;
    }
    throw new Error("Timeline pagination incomplete");
  }
  async ready(): Promise<{ ready: Pull[]; excluded: { number: number; reason: string }[] }> {
    const pulls = await this.pages(
      `pulls?state=open&base=${encodeURIComponent(this.config.baseBranch)}`,
    );
    const ready: Pull[] = [],
      excluded: { number: number; reason: string }[] = [];
    for (const pull of pulls) {
      const number = Number(pull.number);
      const queueReady =
        Array.isArray(pull.labels) && pull.labels.some((l: Json) => l.name === "queue-ready");
      if (!pull.auto_merge && !queueReady) {
        excluded.push({ number, reason: "no ready signal" });
        continue;
      }
      let events: ReadyEvent[];
      try {
        events = await this.timeline(number);
      } catch (error) {
        // An unavailable/malformed per-PR timeline is an explicit admission exclusion.
        // Authentication/rate-limit failures abort the whole observation instead.
        if (error instanceof ProviderError) throw error;
        excluded.push({ number, reason: "actual ready-event timeline unavailable" });
        continue;
      }
      const comments = (await this.pages(`issues/${number}/comments`)).map(
        (x): Comment => ({
          id: String(x.id),
          body: x.body,
          updatedAt: x.updated_at,
          authorAssociation: x.author_association,
        }),
      );
      const input: PullInput = {
        number,
        headSha: pull.head?.sha ?? "",
        headRef: pull.head?.ref ?? "",
        draft: Boolean(pull.draft),
        autoMerge: Boolean(pull.auto_merge),
        queueReady,
        events,
        comments,
      };
      const admission = admit(input);
      if (admission.ready) ready.push(admission.ready);
      else excluded.push({ number, reason: admission.reason });
    }
    return { ready, excluded };
  }
  async runs(manifest: Manifest, branch: string): Promise<Run[]> {
    const raw = await this.pages(
      `actions/workflows/batch-ci.yml/runs?branch=${encodeURIComponent(branch)}&event=push`,
      "workflow_runs",
    );
    const result: Run[] = [];
    for (const run of raw) {
      if (
        run.head_sha !== manifest.tipSha ||
        run.head_branch !== branch ||
        run.path !== this.config.workflow ||
        run.event !== "push"
      )
        continue;
      const count = Number(run.run_attempt);
      if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
        throw new Error("Invalid workflow attempt count");
      for (let attempt = 1; attempt <= count; attempt++) {
        const details =
          attempt === count
            ? run
            : ((await this.get(`actions/runs/${run.id}/attempts/${attempt}`)) as Json);
        const exact =
          details.head_sha === manifest.tipSha &&
          details.head_branch === branch &&
          details.path === this.config.workflow &&
          details.event === "push" &&
          Number(details.run_attempt) === attempt &&
          Number(details.id) === Number(run.id);
        if (!exact) continue;
        const status =
          details.status === "completed"
            ? "completed"
            : details.status === "in_progress"
              ? "in_progress"
              : "queued";
        let outcome: Outcome = details.conclusion === "cancelled" ? "cancelled" : "unknown";
        let trusted = false;
        if (status === "completed") {
          const attested = await this.resultArtifact(manifest, Number(run.id), attempt);
          if (
            attested &&
            (attested !== "success" || details.conclusion === "success") &&
            (attested !== "code_failure" || details.conclusion === "failure")
          ) {
            outcome = attested;
            trusted = true;
          }
        }
        result.push({
          id: Number(run.id),
          attempt,
          headSha: manifest.tipSha,
          branch,
          workflow: this.config.workflow,
          status,
          outcome,
          trusted,
          completedAt: status === "completed" ? details.updated_at : null,
        });
      }
    }
    return result;
  }
  async resultArtifact(
    manifest: Manifest,
    runId: number,
    attempt: number,
  ): Promise<Outcome | null> {
    const artifacts = await this.pages(`actions/runs/${runId}/artifacts`, "artifacts");
    const matches: Outcome[] = [];
    for (const a of artifacts) {
      if (
        a.name !== "batch-result" ||
        a.expired ||
        a.size_in_bytes > 1_000_000 ||
        a.workflow_run?.id !== runId ||
        a.workflow_run?.head_sha !== manifest.tipSha
      )
        continue;
      const token = await this.auth.token();
      const response = await this.transport(
        `https://api.github.com/repos/${this.config.repository}/actions/artifacts/${a.id}/zip`,
        {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        },
      );
      let download = response;
      if (response.status === 302) {
        const target = new URL(response.headers.get("location") ?? "");
        if (target.protocol !== "https:") continue;
        // Never forward the repository credential to the artifact storage origin.
        download = await this.transport(target, { signal: AbortSignal.timeout(30_000) });
      }
      if (!download.ok) {
        if ([404, 410].includes(download.status)) continue;
        throw new ProviderError(download.status, "artifact download");
      }
      try {
        const body = readResultZip(new Uint8Array(await download.arrayBuffer()));
        const data = JSON.parse(body) as Json;
        if (
          data.schemaVersion === 1 &&
          data.batchId === manifest.batchId &&
          data.headSha === manifest.tipSha &&
          data.runId === runId &&
          data.runAttempt === attempt &&
          ["success", "code_failure", "infrastructure", "cancelled"].includes(data.outcome)
        )
          matches.push(data.outcome);
      } catch {
        /* Malformed artifacts are unknown, never code-red. */
      }
    }
    return matches.length === 1 ? matches[0]! : null;
  }
}

// Small bounded ZIP reader: no extraction paths, subprocesses, third-party APIs,
// or artifact-controlled filenames written to disk. Uses central-directory sizes.
export function readResultZip(bytes: Uint8Array): string {
  if (bytes.byteLength > 1_000_000) throw new Error("Artifact too large");
  const b = Buffer.from(bytes);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0 || b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6)) throw new Error("Invalid ZIP");
  const count = b.readUInt16LE(end + 10);
  if (count < 1 || count > 10) throw new Error("Invalid ZIP entry count");
  let position = b.readUInt32LE(end + 16);
  const results: string[] = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(position) !== 0x02014b50) throw new Error("Invalid directory");
    const flags = b.readUInt16LE(position + 8),
      compression = b.readUInt16LE(position + 10);
    const compressed = b.readUInt32LE(position + 20),
      size = b.readUInt32LE(position + 24);
    const nameLength = b.readUInt16LE(position + 28),
      extra = b.readUInt16LE(position + 30),
      comment = b.readUInt16LE(position + 32);
    const name = b.subarray(position + 46, position + 46 + nameLength).toString();
    const offset = b.readUInt32LE(position + 42);
    position += 46 + nameLength + extra + comment;
    if (!["batch-result.json", "result.json"].includes(name)) continue;
    if (
      flags & 1 ||
      size > 65_536 ||
      compressed > 1_000_000 ||
      b.readUInt32LE(offset) !== 0x04034b50
    )
      throw new Error("Invalid result entry");
    const start = offset + 30 + b.readUInt16LE(offset + 26) + b.readUInt16LE(offset + 28);
    if (start + compressed > b.length) throw new Error("Truncated ZIP");
    const data = b.subarray(start, start + compressed);
    const decoded =
      compression === 0
        ? data
        : compression === 8
          ? inflateRawSync(data, { maxOutputLength: 65_536 })
          : null;
    if (!decoded || decoded.length !== size) throw new Error("Invalid compression");
    results.push(decoded.toString("utf8"));
  }
  if (results.length !== 1) throw new Error("Ambiguous result artifact");
  return results[0]!;
}

export interface Capabilities {
  atomicRefs: boolean;
  atomicReadyFence: boolean;
  fencedSideEffects: boolean;
  reason: string;
}
export const githubCapabilities: Capabilities = {
  atomicRefs: false,
  atomicReadyFence: false,
  fencedSideEffects: false,
  reason:
    "GitHub adapter has no verified atomic multi-ref receive-pack support or transaction binding PR head/readiness/comments to a main ref update; REST rerun/comment cannot be fenced atomically with a Git lease. Active mode is unavailable until a provider implements these contracts.",
};
export function requireActiveCapabilities(caps: Capabilities): void {
  if (!caps.atomicRefs || !caps.atomicReadyFence || !caps.fencedSideEffects)
    throw new Error(caps.reason);
}

// Explicit write surface, not instantiated or reachable by the shadow runner.
// A provider implementation must also supply atomic ready-state and side-effect
// fencing before Controller will call these methods.
export class GitHubMutations {
  constructor(readonly reader: GitHubReader) {}
  private async post(path: string, body: unknown): Promise<void> {
    if (this.reader.config.mode !== "active")
      throw new Error("Shadow mode forbids GitHub mutations");
    const token = await this.reader.auth.token();
    const response = await this.reader.transport(
      `https://api.github.com/repos/${this.reader.config.repository}/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new ProviderError(response.status, "mutation");
  }
  async retry(run: Run): Promise<void> {
    await this.post(`actions/runs/${run.id}/rerun`, {});
  }
  async announce(number: number, body: string): Promise<void> {
    await this.post(`issues/${number}/comments`, { body });
  }
}
