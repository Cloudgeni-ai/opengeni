import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { admitCanaryConfirmation } from "./confirm-canary-publication";
import { canaryCohortHandoff, canarySitePins, parseCanaryCohort } from "./publish-canary";

const sha = "a".repeat(40);
const version = "4.2.1-canary.1234001";
const integrity = `sha512-${createHash("sha512").update("archive").digest("base64")}`;
const names = ["@opengeni/sdk", "@opengeni/react", "@opengeni/codemode", "@opengeni/ogtool"];
const identity = { source: sha, workflowSource: sha, runId: "1234", attempt: "1" };
const packages = [...names, "@opengeni/runtime"].map((name) => ({
  name,
  version,
  previousLatest: "3.4.0",
  integrity,
  archiveBytes: 7_435_615,
}));
const env = (overrides: Record<string, string | undefined> = {}) => ({
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "Cloudgeni-ai/opengeni",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: "Cloudgeni-ai/opengeni/.github/workflows/publish-canary.yml@refs/heads/main",
  GITHUB_SHA: sha,
  GITHUB_WORKFLOW_SHA: sha,
  GITHUB_RUN_ID: "1234",
  GITHUB_RUN_ATTEMPT: "2",
  SOURCE_SHA: sha,
  CANARY_COHORT: canaryCohortHandoff(packages, identity),
  ...overrides,
});

describe("canary confirmation admission", () => {
  test("a re-run confirmation admits the cohort its own run's publish job handed off", () => {
    const cohort = admitCanaryConfirmation(env(), sha);
    expect(cohort.attempt).toBe("1");
    expect(cohort.packages).toEqual(packages);
    expect(canarySitePins(cohort.packages)).toEqual(
      Object.fromEntries(names.map((name) => [name, version])),
    );
  });

  for (const [label, overrides] of Object.entries({
    "publish credentials": { NODE_AUTH_TOKEN: "synthetic" },
    "an OIDC token": { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic" },
    "a missing handoff": { CANARY_COHORT: "" },
    "another run's handoff": { GITHUB_RUN_ID: "1235" },
    "another source": { SOURCE_SHA: "b".repeat(40) },
    "a later attempt's handoff": {
      CANARY_COHORT: canaryCohortHandoff(packages, { ...identity, attempt: "3" }),
    },
    "another workflow": {
      GITHUB_WORKFLOW_REF:
        "Cloudgeni-ai/opengeni/.github/workflows/reconcile-canary-publication.yml@refs/heads/main",
    },
  })) {
    test(`refuses ${label}`, () => {
      expect(() => admitCanaryConfirmation(env(overrides), sha)).toThrow();
    });
  }

  test("the handoff accepts only exact package identities", () => {
    const valid = JSON.parse(canaryCohortHandoff(packages, identity));
    for (const change of [
      { name: "left-pad" },
      { version: "4.2.1" },
      { integrity: "sha512-short" },
      { archiveBytes: 0 },
      { previousLatest: "latest" },
      { unexpected: true },
    ]) {
      const cohort = structuredClone(valid);
      Object.assign(cohort.packages[0], change);
      expect(() => parseCanaryCohort(JSON.stringify(cohort), identity)).toThrow("package");
    }
    const duplicate = structuredClone(valid);
    duplicate.packages.push(duplicate.packages[0]);
    expect(() => parseCanaryCohort(JSON.stringify(duplicate), identity)).toThrow("package");
    expect(() => parseCanaryCohort("not json", identity)).toThrow("not JSON");
  });
});

describe("publish and confirmation jobs", () => {
  type Step = {
    name: string;
    id?: string;
    run?: string;
    env?: Record<string, string>;
    if?: string;
  };
  type Job = {
    name: string;
    needs?: string;
    environment?: string;
    permissions?: Record<string, string>;
    outputs?: Record<string, string>;
    "timeout-minutes": number;
    steps: (Step & { with?: Record<string, unknown> })[];
  };
  const workflow = parse(
    readFileSync(join(import.meta.dir, "../.github/workflows/publish-canary.yml"), "utf8"),
  ) as { jobs: { publish: Job; confirm: Job } };
  const { publish, confirm } = workflow.jobs;

  test("only the publish job holds registry credentials; it hands its cohort to confirmation", () => {
    expect(publish.environment).toBe("package-release");
    expect(publish.outputs).toEqual({ cohort: "${{ steps.publish.outputs.cohort }}" });
    expect(publish.steps.find((step) => step.id === "publish")?.name).toBe(
      "Publish canary versions",
    );
    expect(confirm.needs).toBe("publish");
    expect(confirm.environment).toBeUndefined();
    expect(confirm.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(confirm)).not.toContain("secrets.");
    const wait = confirm.steps.find((step) => step.run?.includes("confirm-canary-publication.ts"));
    expect(wait?.env?.CANARY_COHORT).toBe("${{ needs.publish.outputs.cohort }}");
    expect(confirm["timeout-minutes"]).toBe(40);
  });

  test("Site pins come only from a successful confirmation; receipts are per attempt", () => {
    const upload = (job: Job, prefix: string) =>
      job.steps.filter((step) => String(step.with?.name ?? "").startsWith(prefix));
    expect(upload(publish, "site-package-versions-")).toHaveLength(0);
    const [pins] = upload(confirm, "site-package-versions-");
    expect(pins?.if).toBeUndefined();
    expect(pins?.with?.name).toBe("site-package-versions-${{ inputs.source_sha }}");
    expect(upload(publish, "canary-publication-receipts-")[0]?.with?.name).toBe(
      "canary-publication-receipts-${{ inputs.source_sha }}-${{ github.run_attempt }}",
    );
    expect(upload(confirm, "canary-confirmation-receipts-")[0]?.if).toBe("always()");
  });
});
