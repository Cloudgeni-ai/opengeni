import { compareText, digest, SHA, type Pull } from "./model";
import type { ReadyEvent, Admission } from "./evidence";

// Exact companion to the reviewed App-only ruleset. This is a routing fence,
// never a hosted test result; all actual CI requirements remain mandatory.
export const appOnlyGuidanceContext = "merge-batcher: run gh pr merge --auto (or add queue-ready)";

export interface RequiredCheck {
  context: string;
  integrationId?: number | null;
}
export interface HostedCheck {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  appId: number;
  appSlug: string;
  runId: number;
  attempt: number;
  workflow: string;
  runHeadSha: string;
  hosted: boolean;
}
export interface GitHubAdmissionInput {
  number: number;
  headSha: string;
  headRef: string;
  draft: boolean;
  queueReady: boolean;
  events: ReadyEvent[];
  checks: HostedCheck[];
  required: RequiredCheck[];
  expectedBatcherAppId?: number | undefined;
  reviewRequired: boolean;
  reviewDecision: string | null;
  unresolvedThreads: boolean;
  conversationResolutionRequired: boolean;
  controlPlane?: boolean;
}

// Runtime admission is provider evidence, not prose attestations. Keep the old
// binding fields so historical ledger/manifest records remain readable.
export function admitGitHub(input: GitHubAdmissionInput): Admission {
  const no = (reason: string): Admission => ({ ready: null, reason });
  if (!SHA.test(input.headSha)) return no("invalid exact head");
  if (input.draft) return no("draft");
  if (!input.queueReady) return no("queue-ready label required");
  let event: ReadyEvent | undefined;
  for (const item of input.events
    .filter((e) => e.source === "queue-ready" && Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || compareText(a.id, b.id))) {
    if (!item.enabled) event = undefined;
    else event ??= item;
  }
  if (!event) return no("actual queue-ready timestamp unavailable");
  if (input.reviewRequired && input.reviewDecision !== "APPROVED")
    return no("existing branch-rule review requirement not satisfied");
  if (input.conversationResolutionRequired && input.unresolvedThreads)
    return no("existing branch-rule conversation requirement not satisfied");
  const required = [{ context: "PR CI", integrationId: 15368 }, ...input.required];
  const proofs: HostedCheck[] = [];
  for (const requirement of required) {
    if (
      requirement.context === appOnlyGuidanceContext &&
      Number.isSafeInteger(input.expectedBatcherAppId) &&
      input.expectedBatcherAppId! > 0 &&
      requirement.integrationId === input.expectedBatcherAppId
    )
      continue;
    const candidates = input.checks.filter(
      (c) =>
        c.name === requirement.context &&
        c.headSha === input.headSha &&
        (!requirement.integrationId ||
          requirement.integrationId < 0 ||
          c.appId === requirement.integrationId),
    );
    const check = candidates.sort((a, b) => b.id - a.id)[0];
    if (!check || check.status !== "completed" || check.conclusion !== "success")
      return no(`required GitHub CI not green: ${requirement.context}`);
    if (
      check.appSlug !== "github-actions" ||
      !check.hosted ||
      check.runHeadSha !== input.headSha ||
      !Number.isSafeInteger(check.runId) ||
      check.runId <= 0 ||
      !Number.isSafeInteger(check.attempt) ||
      check.attempt <= 0
    )
      return no(`required check lacks exact-head GitHub-hosted proof: ${requirement.context}`);
    if (requirement.context === "PR CI" && check.workflow !== ".github/workflows/pr-ci.yml")
      return no("PR CI workflow identity mismatch");
    proofs.push(check);
  }
  const evidence = [...new Map(proofs.map((c) => [c.id, c])).values()]
    .sort((a, b) => a.id - b.id)
    .map((c) => ({
      id: c.id,
      name: c.name,
      runId: c.runId,
      attempt: c.attempt,
      headSha: c.headSha,
      workflow: c.workflow,
    }));
  const ready: Pull = {
    number: input.number,
    headSha: input.headSha,
    headRef: input.headRef,
    ...(input.controlPlane ? { controlPlane: true } : {}),
    binding: {
      eventId: event.id,
      at: event.at,
      source: "queue-ready",
      evidenceId: `github-ci:${evidence.map((c) => c.id).join(",")}`,
      evidenceDigest: digest({
        schema: "github-required-ci/v1",
        headSha: input.headSha,
        required,
        checks: evidence,
      }),
    },
  };
  return { ready, reason: null };
}
