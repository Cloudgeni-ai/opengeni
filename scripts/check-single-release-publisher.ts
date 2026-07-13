import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkflowDocument {
  file: string;
  document: unknown;
}

export interface ReleasePublisherFinding {
  file: string;
  location: string;
  reason: string;
}

const runtimeImage = /ghcr\.io\/cloudgeni-ai\/opengeni-(?:api|worker|web|relay)(?=[:@\s'"}]|$)/i;
const chartArtifact = /(?:oci:\/\/ghcr\.io\/[^\s'"}]+\/charts|charts\/opengeni)/i;
const pushCommand =
  /(?:^|[;&|\n])\s*(?:helm|docker|podman|buildah|oras)\s+push\b|(?:^|[;&|\n])\s*skopeo\s+copy\b|(?:^|[;&|\n])\s*crane\s+(?:push|copy)\b/im;
const pinnedAction = /^[^\s@]+@[0-9a-f]{40}$/;

export function releasePublisherFindings(
  workflows: readonly WorkflowDocument[],
): ReleasePublisherFinding[] {
  const findings: ReleasePublisherFinding[] = [];
  for (const workflow of workflows) {
    const document = record(workflow.document);
    const jobs = record(document.jobs);
    rejectPackageWrite(workflow.file, "permissions", record(document.permissions), findings);

    for (const [jobName, rawJob] of Object.entries(jobs)) {
      const job = record(rawJob);
      rejectPackageWrite(
        workflow.file,
        `jobs.${jobName}.permissions`,
        record(job.permissions),
        findings,
      );
      const steps = Array.isArray(job.steps) ? job.steps : [];
      for (let index = 0; index < steps.length; index += 1) {
        const step = record(steps[index]);
        const location = `jobs.${jobName}.steps[${index}]`;
        const uses = typeof step.uses === "string" ? step.uses : "";
        const run = typeof step.run === "string" ? step.run : "";
        const withValues = record(step.with);
        const serialized = JSON.stringify(step);

        if (uses.toLowerCase().startsWith("docker/build-push-action@") && truthy(withValues.push)) {
          findings.push({
            file: workflow.file,
            location,
            reason: "app workflows may not push runtime images; opengeni-ops is the sole publisher",
          });
        }
        if (pushCommand.test(run)) {
          findings.push({
            file: workflow.file,
            location,
            reason: "app workflows may not run registry push commands",
          });
        }
        if (runtimeImage.test(serialized) || chartArtifact.test(serialized)) {
          findings.push({
            file: workflow.file,
            location,
            reason:
              "app workflow references an OPE-25-owned runtime image or chart publication target",
          });
        }
        if (workflow.file === ".github/workflows/release.yml" && uses && !pinnedAction.test(uses)) {
          findings.push({
            file: workflow.file,
            location,
            reason: `npm release action is not pinned to a full commit SHA: ${uses}`,
          });
        }
      }
    }
  }
  return findings;
}

export function loadWorkflowDocuments(directory = ".github/workflows"): WorkflowDocument[] {
  return readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => {
      const path = join(directory, file);
      return {
        file: path,
        document: Bun.YAML.parse(readFileSync(path, "utf8")),
      };
    });
}

function rejectPackageWrite(
  file: string,
  location: string,
  permissions: Record<string, unknown>,
  findings: ReleasePublisherFinding[],
): void {
  if (permissions.packages === "write") {
    findings.push({
      file,
      location,
      reason: "app workflows may not receive package-registry write permission",
    });
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function truthy(value: unknown): boolean {
  return value === true || value === "true";
}

if (import.meta.main) {
  const findings = releasePublisherFindings(loadWorkflowDocuments());
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.location} — ${finding.reason}`);
    }
    process.exit(1);
  }
  console.log("Single release publisher guard passed: app workflows are npm/version-only.");
}
