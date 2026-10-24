import { describe, test, expect } from "bun:test";
import {
  admitGitHub,
  appOnlyGuidanceContext,
  type GitHubAdmissionInput,
  type HostedCheck,
} from "./github-admission";
const head = "a".repeat(40);
const check: HostedCheck = {
  id: 100,
  name: "PR CI",
  headSha: head,
  status: "completed",
  conclusion: "success",
  appId: 15368,
  appSlug: "github-actions",
  runId: 200,
  attempt: 1,
  workflow: ".github/workflows/pr-ci.yml",
  runHeadSha: head,
  hosted: true,
};
const input = (): GitHubAdmissionInput => ({
  number: 42,
  headSha: head,
  headRef: "feature",
  draft: false,
  queueReady: true,
  events: [{ id: "label-1", at: "2026-10-23T00:00:00Z", source: "queue-ready", enabled: true }],
  checks: [{ ...check }],
  required: [],
  reviewRequired: false,
  reviewDecision: null,
  unresolvedThreads: false,
  conversationResolutionRequired: false,
});
describe("GitHub-only admission", () => {
  test("only the exact configured App guidance pair is a routing fence, never CI proof", () => {
    const value = input();
    value.expectedBatcherAppId = 5425399;
    value.required = [{ context: appOnlyGuidanceContext, integrationId: 5425399 }];
    expect(admitGitHub(value).ready).not.toBeNull();
    expect(admitGitHub(value).ready?.binding.evidenceId).toBe("github-ci:100");
    value.checks[0]!.conclusion = "failure";
    expect(admitGitHub(value).ready).toBeNull();
  });
  test("unknown context, wrong App and unbound guidance requirements remain required", () => {
    for (const requirement of [
      { context: `${appOnlyGuidanceContext}!`, integrationId: 5425399 },
      { context: appOnlyGuidanceContext, integrationId: 123 },
      { context: appOnlyGuidanceContext, integrationId: null },
      { context: appOnlyGuidanceContext, integrationId: -1 },
    ]) {
      const value = input();
      value.expectedBatcherAppId = 5425399;
      value.required = [requirement];
      expect(admitGitHub(value).ready).toBeNull();
    }
    for (const expectedBatcherAppId of [undefined, 0, -1, NaN]) {
      const value = input();
      value.expectedBatcherAppId = expectedBatcherAppId;
      value.required = [{ context: appOnlyGuidanceContext, integrationId: 5425399 }];
      expect(admitGitHub(value).ready).toBeNull();
    }
  });
  test("label and hosted exact-head CI suffice without comments, VM evidence or reviewer IDs", () => {
    const admitted = admitGitHub(input());
    expect(admitted.ready?.headSha).toBe(head);
    expect(admitted.ready?.binding.evidenceId).toBe("github-ci:100");
  });
  test("auto-merge admits with a current native request and genuine enable event", () => {
    const value = input();
    value.queueReady = false;
    expect(admitGitHub(value).ready).toBeNull();
    value.queueReady = true;
    value.events[0]!.source = "auto-merge";
    expect(admitGitHub(value).ready).toBeNull();
    value.autoMerge = true;
    value.queueReady = false;
    expect(admitGitHub(value).ready?.binding.source).toBe("auto-merge");
    value.checks[0]!.conclusion = "failure";
    expect(admitGitHub(value).ready).toBeNull();
  });
  test("disable and re-enable create a fresh native binding without label churn", () => {
    const value = input();
    value.autoMerge = true;
    value.events.push({
      id: "auto1",
      at: "2026-10-23T00:01:00Z",
      source: "auto-merge",
      enabled: true,
    });
    expect(admitGitHub(value).ready?.binding.eventId).toBe("auto1");
    value.events.push({
      id: "disable",
      at: "2026-10-23T00:02:00Z",
      source: "auto-merge",
      enabled: false,
    });
    value.autoMerge = false;
    expect(admitGitHub(value).ready?.binding.eventId).toBe("label-1");
    value.autoMerge = true;
    value.events.push({
      id: "auto2",
      at: "2026-10-23T00:03:00Z",
      source: "auto-merge",
      enabled: true,
    });
    expect(admitGitHub(value).ready?.binding.eventId).toBe("auto2");
  });
  test("unlabel/relabel changes readiness binding, unrelated comment churn cannot", () => {
    const value = input(),
      first = admitGitHub(value).ready!;
    value.events.push({
      id: "remove",
      at: "2026-10-23T00:01:00Z",
      source: "queue-ready",
      enabled: false,
    });
    expect(admitGitHub(value).ready).toBeNull();
    value.events.push({
      id: "again",
      at: "2026-10-23T00:02:00Z",
      source: "queue-ready",
      enabled: true,
    });
    expect(admitGitHub(value).ready!.binding.eventId).not.toBe(first.binding.eventId);
  });
  for (const [name, patch] of Object.entries({
    staleHead: { headSha: "b".repeat(40) },
    staleRun: { runHeadSha: "b".repeat(40) },
    selfHosted: { hosted: false },
    pending: { status: "in_progress", conclusion: null },
    failure: { conclusion: "failure" },
    skipped: { conclusion: "skipped" },
    neutral: { conclusion: "neutral" },
    wrongApp: { appId: 999, appSlug: "other" },
    wrongWorkflow: { workflow: ".github/workflows/other.yml" },
    invalidAttempt: { attempt: 0 },
  }))
    test(`refuses ${name}`, () => {
      const value = input();
      Object.assign(value.checks[0]!, patch);
      expect(admitGitHub(value).ready).toBeNull();
    });
  test("new failure revokes older success for same required context", () => {
    const value = input();
    value.checks.push({ ...check, id: 101, conclusion: "failure" });
    expect(admitGitHub(value).ready).toBeNull();
  });
  test("requires every current branch-rule check", () => {
    const value = input();
    value.required = [{ context: "Security", integrationId: 15368 }];
    expect(admitGitHub(value).ready).toBeNull();
    value.checks.push({
      ...check,
      id: 102,
      name: "Security",
      workflow: ".github/workflows/security.yml",
    });
    expect(admitGitHub(value).ready).not.toBeNull();
  });
  test("review and conversation requirements only apply when native branch policy requires", () => {
    const value = input();
    value.reviewDecision = "REVIEW_REQUIRED";
    value.unresolvedThreads = true;
    expect(admitGitHub(value).ready).not.toBeNull();
    value.reviewRequired = true;
    expect(admitGitHub(value).ready).toBeNull();
    value.reviewDecision = "APPROVED";
    expect(admitGitHub(value).ready).not.toBeNull();
    value.conversationResolutionRequired = true;
    expect(admitGitHub(value).ready).toBeNull();
    value.unresolvedThreads = false;
    expect(admitGitHub(value).ready).not.toBeNull();
  });
  test("Version PR uses same hosted proof, no magic author/comment exemption", () => {
    const value = input();
    value.headRef = "changeset-release/main";
    expect(admitGitHub(value).ready).not.toBeNull();
    value.checks = [];
    expect(admitGitHub(value).ready).toBeNull();
  });
  test("rerun proof changes immutable evidence binding", () => {
    const value = input();
    const before = admitGitHub(value).ready!.binding.evidenceDigest;
    value.checks[0]!.attempt++;
    expect(admitGitHub(value).ready!.binding.evidenceDigest).not.toBe(before);
  });
});
