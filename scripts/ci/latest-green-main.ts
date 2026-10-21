#!/usr/bin/env bun
import { execFileSync } from "node:child_process";

// Discovery only; release tooling must still verify ancestry, exact-run success,
// image receipts and its ordinary admission. Never reinterpret queue green as full green.
export function latestGreenMain(
  repository = "Cloudgeni-ai/opengeni",
  api: (path: string) => any = (path) =>
    JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" })),
) {
  for (let page = 1; page <= 10; page++) {
    const runs = api(
      `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=100&page=${page}`,
    ).workflow_runs;
    for (const run of runs) {
      const statuses = api(`repos/${repository}/commits/${run.head_sha}/statuses?per_page=100`);
      const status = statuses.find(
        (s: { context: string; state: string; target_url: string }) =>
          s.context === "Full CI" && s.state === "success" && s.target_url === run.html_url,
      );
      if (status)
        return {
          schemaVersion: 1,
          sha: run.head_sha,
          runId: run.id,
          runAttempt: run.run_attempt,
          url: run.html_url,
        };
    }
    if (runs.length < 100) break;
  }
  throw new Error("No successful full main CI receipt found; do not fall back to queue checks");
}

if (import.meta.main) console.log(JSON.stringify(latestGreenMain(process.argv[2]), null, 2));
