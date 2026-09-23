import { spawnSync } from "node:child_process";

const repository = "Cloudgeni-ai/opengeni";

export function deployedSource(value: unknown): string {
  const health = value as { ok?: unknown; service?: unknown; deploymentRevision?: unknown };
  if (
    !health ||
    health.ok !== true ||
    health.service !== "opengeni" ||
    typeof health.deploymentRevision !== "string" ||
    !/^[a-f0-9]{40}$/.test(health.deploymentRevision)
  ) {
    throw new Error("Production must report a healthy exact source revision");
  }
  return health.deploymentRevision;
}

export function candidatePackages(value: unknown, sourceSha: string): string[] {
  const candidate = value as { sourceSha?: unknown; schemaVersion?: unknown; packages?: unknown };
  if (
    !candidate ||
    candidate.sourceSha !== sourceSha ||
    candidate.schemaVersion !== 2 ||
    !Array.isArray(candidate.packages)
  ) {
    throw new Error("Candidate must match the deployed source");
  }
  const seen = new Set<string>();
  return candidate.packages.map((pkg: { name: string; version: string }) => {
    if (
      !pkg ||
      typeof pkg.name !== "string" ||
      !/^@opengeni\/[a-z0-9-]+$/.test(pkg.name) ||
      typeof pkg.version !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
      seen.has(pkg.name)
    ) {
      throw new Error("Candidate must contain unique stable package versions");
    }
    seen.add(pkg.name);
    return `${pkg.name}@${pkg.version}`;
  });
}

function gh(...args: string[]): string {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "GitHub request failed");
  return result.stdout;
}

async function json(url: string, request: typeof fetch): Promise<unknown> {
  const response = await request(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export async function reconcile(runGh = gh, request: typeof fetch = fetch): Promise<void> {
  const sourceSha = deployedSource(await json("https://app.opengeni.ai/healthz", request));
  const candidate = JSON.parse(
    runGh(
      "release",
      "download",
      `opengeni-candidate-${sourceSha}`,
      "--repo",
      repository,
      "--pattern",
      "release-candidate.json",
      "--output",
      "-",
    ),
  );
  const packages = candidatePackages(candidate, sourceSha);
  // Probe availability only. The publisher independently verifies source CI,
  // production ancestry, the complete package closure and registry identity.
  const missing = await Promise.all(
    packages.map(async (spec) => {
      const split = spec.lastIndexOf("@");
      const response = await request(
        `https://registry.npmjs.org/${encodeURIComponent(spec.slice(0, split))}/${spec.slice(split + 1)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (response.status === 404) return true;
      if (!response.ok) throw new Error(`Registry probe failed: HTTP ${response.status}`);
      return false;
    }),
  );
  if (!missing.some(Boolean)) {
    console.log(`${sourceSha}: packages already available`);
    return;
  }
  const runs = JSON.parse(
    runGh("api", `repos/${repository}/actions/workflows/publish-packages.yml/runs?per_page=100`),
  );
  if (
    runs.workflow_runs.some(
      (run: { display_title: string; status: string }) =>
        run.display_title === `publish-packages:${sourceSha}` && run.status !== "completed",
    )
  ) {
    console.log(`${sourceSha}: publication already running`);
    return;
  }
  runGh(
    "workflow",
    "run",
    "publish-packages.yml",
    "--repo",
    repository,
    "--ref",
    "main",
    "-f",
    `source_sha=${sourceSha}`,
    "-f",
    `expected_packages=${packages.join(",")}`,
    "-f",
    "confirm=true",
  );
  console.log(`${sourceSha}: dispatched exact package publication`);
}

if (import.meta.main) await reconcile();
