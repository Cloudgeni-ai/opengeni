#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * Pending changeset release-plan contract, shared by PR fast checks and Batch
 * source contracts so a broken changeset fails its own PR before it can cost a
 * batch. It runs the exact release planner `changeset status` runs, resolved
 * from the installed CLI's own dependency tree, over every pending changeset:
 * an unknown package, a mixed ignored/not-ignored changeset or invalid config
 * throws. `status` additionally demands changesets for packages changed since
 * `baseBranch`; Batch disabled that by pointing main at the candidate, so
 * skipping it here needs no git and never moves a (shared) local main ref.
 */
export type ReleasePlan = { changesets: { releases: unknown[] }[]; releases: unknown[] };

export function releasePlanError(plan: ReleasePlan): string | undefined {
  if (!Array.isArray(plan?.changesets) || !Array.isArray(plan?.releases))
    return "Changesets returned a malformed release plan";
  if (plan.changesets.some((change) => change.releases.length > 0) && plan.releases.length === 0)
    return "Pending changesets cannot produce a Version PR";
  return undefined;
}

function installedReleasePlanner(): (cwd: string) => Promise<ReleasePlan> {
  const cli = createRequire(import.meta.url).resolve("@changesets/cli");
  const planner = createRequire(cli)("@changesets/get-release-plan");
  return planner.default ?? planner;
}

/** Returns an error message, or undefined when the pending release plan is valid. */
export async function checkChangesetPlan(
  options: { cwd?: string | undefined; output?: string | undefined } = {},
): Promise<string | undefined> {
  let plan: ReleasePlan;
  try {
    plan = await installedReleasePlanner()(options.cwd ?? process.cwd());
  } catch (error) {
    return `Invalid pending changeset: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (options.output) writeFileSync(options.output, JSON.stringify(plan, undefined, 2));
  return releasePlanError(plan);
}

export function reportChangesetPlanError(error: string): void {
  console.error(`::error::${error.replaceAll("%", "%25").replaceAll("\n", "%0A")}`);
}

if (import.meta.main) {
  const index = process.argv.indexOf("--output");
  const error = await checkChangesetPlan({
    output: index >= 0 ? process.argv[index + 1] : undefined,
  });
  if (error) {
    reportChangesetPlanError(error);
    process.exit(1);
  }
  console.log("[changeset-plan] pending changesets form a valid release plan");
}
