import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./check-private-ops-boundary.ts", import.meta.url).pathname;

describe("private ops boundary evidence", () => {
  it("passes with private ops repo, protected environments, safe public workflows, and explicit proofs", () => {
    const fixture = fixtureDir("pull_request:\n");
    const scanEvidence = join(fixture.dir, "gitleaks-output.txt");
    writeFileSync(scanEvidence, "no leaks found");
    const out = join(fixture.dir, "private-ops.json");

    const result = runScript(fixture, out, [
      "--evidence",
      scanEvidence,
      "--secret-scan-passed",
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.ok).toBe(true);
    expect(payload.checks[0].metrics.publicPrSecretsBlocked).toBe(true);
    expect(payload.checks[0].evidence).toContain(scanEvidence);
  });

  it("fails when public workflows use pull_request_target", () => {
    const fixture = fixtureDir("pull_request_target:\n");
    const out = join(fixture.dir, "private-ops.json");

    const result = runScript(fixture, out, ["--secret-scan-passed"]);

    expect(result.status).not.toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.checks[0].metrics.publicPrSecretsBlocked).toBe(false);
  });
});

function runScript(
  fixture: ReturnType<typeof fixtureDir>,
  out: string,
  extra: string[],
): ReturnType<typeof spawnSync<string>> {
    return spawnSync("bun", [
      scriptPath,
      "--ops-repo-json", fixture.repo,
      "--environments-json", fixture.environments,
      "--deployment-evidence-json", fixture.deploymentEvidence,
      "--oidc-federated-credential-json", fixture.oidc,
      "--workflow-run-json", fixture.workflowRun,
      "--workflow-root", fixture.workflows,
      "--out", out,
    ...extra,
  ], { encoding: "utf8" });
}

function fixtureDir(workflowTrigger: string): {
  dir: string;
  repo: string;
  environments: string;
  deploymentEvidence: string;
  oidc: string;
  workflowRun: string;
  workflows: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "opengeni-private-ops-"));
  const workflows = join(dir, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  const repo = join(dir, "repo.json");
  const environments = join(dir, "environments.json");
  const deploymentEvidence = join(dir, "deployment-evidence.json");
  const oidc = join(dir, "oidc.json");
  const workflowRun = join(dir, "workflow-run.json");
  writeFileSync(repo, JSON.stringify({ isPrivate: true, nameWithOwner: "Cloudgeni-ai/opengeni-ops" }));
  writeFileSync(environments, JSON.stringify({
    environments: [{ name: "preview" }, { name: "staging" }, { name: "production" }],
  }));
  writeFileSync(deploymentEvidence, JSON.stringify({
    ok: true,
    opsRepo: "Cloudgeni-ai/opengeni-ops",
    environment: "staging",
    gitSha: "4ecb7a77078c82db8a2dddf7ace3a45e9bc00d20",
    imageDigests: {
      api: "sha256:b47ad64f00a8707496ba472750b90793df891bcaf8d2f124891bc1c094b5c2ef",
      worker: "sha256:22b4b34246d2a2f9ea804fa5facab6e1e7f515f67a1a3e34ed73c38f6104a2e4",
      web: "sha256:2978da4a5fd649c9739ccdde93323a51800581969763efd7ed36c027dfa5104e",
    },
  }));
  writeFileSync(oidc, JSON.stringify({
    issuer: "https://token.actions.githubusercontent.com",
    subject: "repo:Cloudgeni-ai/opengeni-ops:environment:staging",
    audiences: ["api://AzureADTokenExchange"],
  }));
  writeFileSync(workflowRun, JSON.stringify({
    status: "completed",
    conclusion: "success",
    jobs: [{
      steps: [
        { name: "Validate immutable image inputs", conclusion: "success" },
        { name: "Deploy digest-pinned images", conclusion: "success" },
        { name: "Upload deployment evidence", conclusion: "success" },
      ],
    }],
  }));
  writeFileSync(join(workflows, "ci.yml"), `on:\n  ${workflowTrigger}jobs:\n  test:\n    steps:\n      - run: echo ok\n`);
  return { dir, repo, environments, deploymentEvidence, oidc, workflowRun, workflows };
}
