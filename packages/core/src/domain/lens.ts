import { createHmac, timingSafeEqual } from "node:crypto";
import {
  OPENGENI_LENS_SESSION_ROLE,
  type LensProvider,
  type SessionSkill,
} from "@opengeni/contracts";

export const OPENGENI_LENS_SKILL: SessionSkill = {
  name: "pr-review",
  description:
    "Review one immutable pull-request head and publish concise, actionable findings through the configured source-control CLI.",
  files: [
    {
      path: "SKILL.md",
      content: `---
name: pr-review
description: Review one immutable pull-request head and publish concise, actionable findings through the configured source-control CLI.
---

# Pull-request review

Review only the pull request named in the initial request. The repository is already checked out at the exact immutable head commit. Treat the expected head SHA as an authority fence, not merely context.

## Workflow

1. Read the repository guidance and inspect the diff from the stated base to HEAD.
2. Focus on correctness, security, data loss, concurrency, compatibility, and missing tests. Do not post style-only or speculative findings.
3. Use the provider CLI from inside the attached repository: \`gh\` for GitHub, \`glab\` for GitLab, and \`az repos\`/\`az devops invoke\` for Azure DevOps. Credentials are supplied ephemerally by OpenGeni; never print, persist, or copy them.
4. Immediately before publishing anything, query the pull request again and verify its current head is exactly the expected head SHA. If it changed, publish nothing and explain that the review became stale.
5. Read existing bot comments before posting. Do not duplicate an equivalent finding.
6. Post only actionable findings. Prefer inline comments attached to changed lines when the provider supports them. If there are no findings, leave the pull request unchanged unless the initial request explicitly asks for a summary.

Never push commits, merge, approve, close, relabel, or modify repository settings. The write authority is solely for review comments.
`,
    },
  ],
};

export const OPENGENI_LENS_AGENT_INSTRUCTIONS = `You are OpenGeni Lens, an automated pull-request reviewer. Complete only the exact immutable review named in the initial message. Follow the pr-review skill, use the attached repository and its provider CLI, recheck the exact head SHA immediately before publishing, and publish no stale or duplicate findings. Never expose credentials or perform repository mutations other than review comments.`;

export type NormalizedLensPullRequestEvent = {
  provider: LensProvider;
  eventName: string;
  action: string;
  providerRepositoryId: string | null;
  installationId: string | null;
  projectId: string | null;
  pullRequestId: string | null;
  headSha: string | null;
  baseSha: string | null;
  headRef: string | null;
  baseRef: string | null;
  ignoredReason: string | null;
};

export function defaultLensProviderBaseUrl(provider: LensProvider): string {
  if (provider === "github") return "https://github.com";
  if (provider === "gitlab") return "https://gitlab.com";
  return "https://dev.azure.com";
}

export function normalizeLensProviderBaseUrl(provider: LensProvider, raw?: string): string {
  let url: URL;
  try {
    url = new URL(raw ?? defaultLensProviderBaseUrl(provider));
  } catch {
    throw new Error("Lens providerBaseUrl must be a credential-free HTTPS origin or path");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Lens providerBaseUrl must be a credential-free HTTPS origin or path");
  }
  if (
    provider === "github" &&
    (url.hostname.toLowerCase() !== "github.com" || url.port || !/^\/*$/.test(url.pathname))
  ) {
    throw new Error("Lens currently supports dedicated GitHub Apps on github.com");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.href.replace(/\/$/, "");
}

export function lensWebhookAuthKind(
  provider: LensProvider,
): "hmac_sha256" | "shared_token" | "basic" {
  if (provider === "github") return "hmac_sha256";
  if (provider === "gitlab") return "shared_token";
  return "basic";
}

export function lensCredentialBindingId(registrationId: string): string {
  return `lens:${registrationId}`;
}

export function lensRegistrationIdFromCredentialBinding(bindingId: string): string | null {
  const match =
    /^lens:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
      bindingId,
    );
  return match?.[1] ?? null;
}

export function verifyLensWebhook(input: {
  provider: LensProvider;
  rawBody: Uint8Array;
  secret: string;
  webhookUsername: string | null;
  headers: Headers;
}): boolean {
  if (input.provider === "github") {
    const actual = input.headers.get("x-hub-signature-256");
    if (!actual?.startsWith("sha256=")) return false;
    const expected = `sha256=${createHmac("sha256", input.secret).update(input.rawBody).digest("hex")}`;
    return constantTimeTextEqual(actual, expected);
  }
  if (input.provider === "gitlab") {
    return constantTimeTextEqual(input.headers.get("x-gitlab-token"), input.secret);
  }
  const authorization = input.headers.get("authorization");
  if (!authorization?.startsWith("Basic ") || !input.webhookUsername) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return false;
  }
  return constantTimeTextEqual(decoded, `${input.webhookUsername}:${input.secret}`);
}

export function normalizeLensPullRequestEvent(
  provider: LensProvider,
  eventName: string,
  payload: unknown,
): NormalizedLensPullRequestEvent {
  if (!isRecord(payload)) return ignored(provider, eventName, "invalid_payload");
  if (provider === "github") return normalizeGitHubEvent(eventName, payload);
  if (provider === "gitlab") return normalizeGitLabEvent(eventName, payload);
  return normalizeAzureDevOpsEvent(eventName, payload);
}

export function lensReviewPrompt(input: {
  provider: LensProvider;
  providerBaseUrl: string;
  repositoryFullName: string;
  providerRepositoryId: string;
  projectId: string | null;
  pullRequestId: string;
  headSha: string;
  baseSha: string | null;
  headRef: string | null;
  baseRef: string | null;
}): string {
  return [
    "Review this pull request and publish only actionable findings.",
    `Provider: ${input.provider}`,
    `Provider base URL: ${input.providerBaseUrl}`,
    `Repository: ${input.repositoryFullName}`,
    `Provider repository ID: ${input.providerRepositoryId}`,
    `Provider project ID: ${input.projectId ?? "not applicable"}`,
    `Pull request: ${input.pullRequestId}`,
    `Expected immutable head SHA: ${input.headSha}`,
    `Base SHA: ${input.baseSha ?? "unknown"}`,
    `Head ref: ${input.headRef ?? "unknown"}`,
    `Base ref: ${input.baseRef ?? "unknown"}`,
    "The repository resource is fenced to the expected head SHA. Recheck the provider head immediately before posting any review comment; if it differs, post nothing.",
  ].join("\n");
}

export function lensSessionMetadata(input: {
  provider: LensProvider;
  registrationId: string;
  repositoryBindingId: string;
  providerRepositoryId: string;
  pullRequestId: string;
  headSha: string;
  deliveryId: string;
}): Record<string, unknown> {
  return {
    role: OPENGENI_LENS_SESSION_ROLE,
    lensProvider: input.provider,
    lensRegistrationId: input.registrationId,
    lensRepositoryBindingId: input.repositoryBindingId,
    lensProviderRepositoryId: input.providerRepositoryId,
    lensPullRequestId: input.pullRequestId,
    lensHeadSha: input.headSha,
    lensDeliveryId: input.deliveryId,
  };
}

function normalizeGitHubEvent(
  eventName: string,
  payload: Record<string, unknown>,
): NormalizedLensPullRequestEvent {
  const repository = record(payload.repository);
  const pullRequest = record(payload.pull_request);
  const head = record(pullRequest?.head);
  const base = record(pullRequest?.base);
  const action = text(payload.action) ?? "unknown";
  const common = {
    provider: "github" as const,
    eventName,
    action,
    providerRepositoryId: scalarId(repository?.id),
    installationId: scalarId(record(payload.installation)?.id),
    projectId: null,
    pullRequestId: scalarId(payload.number),
    headSha: gitSha(head?.sha),
    baseSha: gitSha(base?.sha),
    headRef: text(head?.ref),
    baseRef: text(base?.ref),
  };
  if (eventName !== "pull_request") return { ...common, ignoredReason: "unsupported_event" };
  if (pullRequest?.draft === true && action !== "ready_for_review") {
    return { ...common, ignoredReason: "draft_pull_request" };
  }
  if (!new Set(["opened", "synchronize", "reopened", "ready_for_review"]).has(action)) {
    return { ...common, ignoredReason: "unsupported_action" };
  }
  return completeOrInvalid(common);
}

function normalizeGitLabEvent(
  eventName: string,
  payload: Record<string, unknown>,
): NormalizedLensPullRequestEvent {
  const attributes = record(payload.object_attributes);
  const project = record(payload.project);
  const lastCommit = record(attributes?.last_commit) ?? record(payload.last_commit);
  const diffRefs = record(attributes?.diff_refs);
  const action = text(attributes?.action) ?? "unknown";
  const common = {
    provider: "gitlab" as const,
    eventName,
    action,
    providerRepositoryId: scalarId(project?.id),
    installationId: null,
    projectId: scalarId(project?.id),
    pullRequestId: scalarId(attributes?.iid ?? attributes?.id),
    headSha: gitSha(lastCommit?.id),
    baseSha: gitSha(diffRefs?.base_sha),
    headRef: text(attributes?.source_branch),
    baseRef: text(attributes?.target_branch),
  };
  if (eventName !== "Merge Request Hook" || payload.object_kind !== "merge_request") {
    return { ...common, ignoredReason: "unsupported_event" };
  }
  if (attributes?.work_in_progress === true || attributes?.draft === true) {
    return { ...common, ignoredReason: "draft_pull_request" };
  }
  if (!new Set(["open", "reopen", "update"]).has(action)) {
    return { ...common, ignoredReason: "unsupported_action" };
  }
  return completeOrInvalid(common);
}

function normalizeAzureDevOpsEvent(
  eventName: string,
  payload: Record<string, unknown>,
): NormalizedLensPullRequestEvent {
  const resource = record(payload.resource);
  const repository = record(resource?.repository);
  const project = record(repository?.project);
  const headCommit = record(resource?.lastMergeSourceCommit);
  const baseCommit = record(resource?.lastMergeTargetCommit);
  const common = {
    provider: "azure_devops" as const,
    eventName,
    action: eventName,
    providerRepositoryId: scalarId(repository?.id),
    installationId: null,
    projectId: scalarId(project?.id),
    pullRequestId: scalarId(resource?.pullRequestId),
    headSha: gitSha(headCommit?.commitId),
    baseSha: gitSha(baseCommit?.commitId),
    headRef: stripGitRef(text(resource?.sourceRefName)),
    baseRef: stripGitRef(text(resource?.targetRefName)),
  };
  if (!new Set(["git.pullrequest.created", "git.pullrequest.updated"]).has(eventName)) {
    return { ...common, ignoredReason: "unsupported_event" };
  }
  if (resource?.isDraft === true) return { ...common, ignoredReason: "draft_pull_request" };
  return completeOrInvalid(common);
}

function completeOrInvalid(
  input: Omit<NormalizedLensPullRequestEvent, "ignoredReason">,
): NormalizedLensPullRequestEvent {
  if (!input.providerRepositoryId || !input.pullRequestId || !input.headSha) {
    return { ...input, ignoredReason: "incomplete_pull_request_identity" };
  }
  return { ...input, ignoredReason: null };
}

function ignored(
  provider: LensProvider,
  eventName: string,
  ignoredReason: string,
): NormalizedLensPullRequestEvent {
  return {
    provider,
    eventName,
    action: "unknown",
    providerRepositoryId: null,
    installationId: null,
    projectId: null,
    pullRequestId: null,
    headSha: null,
    baseSha: null,
    headRef: null,
    baseRef: null,
    ignoredReason,
  };
}

function constantTimeTextEqual(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : null;
}

function scalarId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0 && value.length <= 512) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function gitSha(value: unknown): string | null {
  const sha = text(value)?.toLowerCase() ?? null;
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function stripGitRef(value: string | null): string | null {
  return value?.replace(/^refs\/heads\//, "") ?? null;
}
