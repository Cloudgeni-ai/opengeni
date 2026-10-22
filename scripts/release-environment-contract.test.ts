import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const workflowDir = resolve(import.meta.dir, "../.github/workflows");
const ciEnvironment =
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'public-release' || 'ci-build' }}";
const signing = ["APPLE_ASC_KEY", "APPLE_CERT_P12", "APPLE_CERT_PASSWORD"];
const credentials: Record<string, readonly string[]> = {
  "package-release": ["NPM_TOKEN"],
  "production-release": ["NPM_TOKEN"],
  "embedded-release": ["NPM_TOKEN"],
  "agent-release": [...signing, "APPLE_DEVELOPER_ID", "OPENGENI_AGENT_MINISIGN_KEY"],
  "desktop-release": signing,
  "public-release": ["OPENGENI_AGENT_MINISIGN_KEY"],
};
const workflows = new Map(
  readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, parse(readFileSync(resolve(workflowDir, name), "utf8"))]),
);

describe("release credential environment boundary", () => {
  test("every signing and registry credential consumer uses an approved environment", () => {
    let consumers = 0;
    for (const [file, workflow] of workflows) {
      for (const [id, job] of Object.entries(workflow.jobs ?? {}) as [string, any][]) {
        const references = [
          ...JSON.stringify(job).matchAll(
            /secrets\.(APPLE_\w+|NPM_TOKEN|OPENGENI_AGENT_MINISIGN_KEY)\b/g,
          ),
        ].map((match) => match[1]!);
        if (references.length === 0) continue;
        consumers++;
        const environment =
          file === "ci.yml" && id === "api-image"
            ? (expect(job.environment).toBe(ciEnvironment), "public-release")
            : typeof job.environment === "string"
              ? job.environment
              : job.environment?.name;
        expect(
          credentials[environment],
          `${file}/${id} must have an approved release environment`,
        ).toBeDefined();
        for (const name of references)
          expect(credentials[environment], `${file}/${id}/${name}`).toContain(name);
      }
    }
    expect(consumers).toBeGreaterThanOrEqual(11);
  });

  test("untrusted CI events cannot select the credential environment or signing step", () => {
    const job = workflows.get("ci.yml").jobs["api-image"];
    expect(job.environment).toBe(ciEnvironment);
    const consumers = job.steps.filter((step: unknown) =>
      JSON.stringify(step).includes("secrets.OPENGENI_AGENT_MINISIGN_KEY"),
    );
    expect(consumers).toHaveLength(1);
    expect(consumers[0].if).toBe(
      "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
    );
  });

  test("existing release gates and credential-free PR jobs remain distinct", () => {
    expect(workflows.get("release-embedded.yml").jobs.release.environment).toBe("embedded-release");
    expect(workflows.get("release-candidate.yml").jobs.candidate.environment).toBe(
      "public-release",
    );
    expect(workflows.get("release.yml").jobs.publish.environment).toBe("production-release");
    for (const [id, job] of Object.entries(workflows.get("ci.yml").jobs) as [string, any][]) {
      if (id !== "api-image") expect(job.environment).toBeUndefined();
    }
    expect(workflows.has("migrate-release-secrets.yml")).toBe(false);
  });
});
