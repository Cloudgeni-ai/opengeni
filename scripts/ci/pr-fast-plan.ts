import { readFileSync, writeFileSync } from "node:fs";
import type { ImpactPlan } from "./impact";
import { createWorkspaceGraph } from "./workspace";

export const PR_UNIT_FILE_CAP = 40;
type Input = Pick<ImpactPlan, "schemaVersion" | "mode" | "changedFiles" | "unitTests">;

/** Admission sampling only; the original full Batch plan is never changed. */
export function selectPrFastPlan<T extends Input>(plan: T, packageDirectories: readonly string[]) {
  if (
    plan.schemaVersion !== 1 ||
    !["full", "focused", "docs"].includes(plan.mode) ||
    !Array.isArray(plan.changedFiles) ||
    !Array.isArray(plan.unitTests) ||
    [...plan.changedFiles, ...plan.unitTests].some((path) => typeof path !== "string")
  )
    throw new Error("Invalid PR impact plan");
  const directories = [...packageDirectories].sort((a, b) => b.length - a.length);
  const owner = (path: string) =>
    directories.find((dir) => path === dir || path.startsWith(`${dir}/`));
  const touched = new Set(
    plan.changedFiles.map(owner).filter((dir): dir is string => Boolean(dir)),
  );
  const direct = [...new Set(plan.unitTests.filter((path) => touched.has(owner(path) ?? "")))];
  const changed = new Set(plan.changedFiles);
  direct.sort((a, b) => Number(changed.has(b)) - Number(changed.has(a)) || a.localeCompare(b));
  const unitTests = plan.mode === "focused" ? direct.slice(0, PR_UNIT_FILE_CAP) : [];
  return {
    ...plan,
    unitTests,
    prAdmissionUnits: {
      policy: "direct-packages-capped-v1",
      reason:
        plan.mode === "full"
          ? "broad-impact-deferred-to-batch"
          : plan.mode === "docs"
            ? "docs-no-admission-units"
            : direct.length > PR_UNIT_FILE_CAP
              ? "direct-package-cap"
              : "direct-packages",
      cap: PR_UNIT_FILE_CAP,
      originalCount: plan.unitTests.length,
      directCount: direct.length,
      selectedCount: unitTests.length,
      deferredCount: plan.unitTests.length - unitTests.length,
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--plan" || args[2] !== "--output")
    throw new Error("usage: pr-fast-plan.ts --plan <impact.json> --output <pr-plan.json>");
  const plan = JSON.parse(readFileSync(args[1]!, "utf8")) as ImpactPlan;
  const selected = selectPrFastPlan(
    plan,
    createWorkspaceGraph().packages.map((pkg) => pkg.dir),
  );
  writeFileSync(args[3]!, JSON.stringify(selected, null, 2));
  console.log(JSON.stringify(selected.prAdmissionUnits));
}
