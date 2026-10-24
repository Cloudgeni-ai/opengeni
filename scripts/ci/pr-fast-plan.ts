import { readFileSync, writeFileSync } from "node:fs";
import { createImpactPlan, type ImpactPlan } from "./impact";
import { createWorkspaceGraph } from "./workspace";

export const PR_UNIT_FILE_CAP = 40;
type Input = Pick<ImpactPlan, "schemaVersion" | "mode" | "changedFiles" | "unitTests" | "reasons">;

/** Admission sampling only; the original full Batch plan is never changed. */
export function selectPrFastPlan<T extends Input>(plan: T, packageDirectories: readonly string[]) {
  if (
    plan.schemaVersion !== 1 ||
    !["full", "focused", "docs"].includes(plan.mode) ||
    !Array.isArray(plan.changedFiles) ||
    !Array.isArray(plan.unitTests) ||
    !Array.isArray(plan.reasons) ||
    [...plan.changedFiles, ...plan.unitTests].some((path) => typeof path !== "string")
  )
    throw new Error("Invalid PR impact plan");
  const directories = [...packageDirectories].sort((a, b) => b.length - a.length);
  const owner = (path: string) =>
    directories.find((dir) => path === dir || path.startsWith(`${dir}/`));
  const touched = new Set(
    plan.changedFiles.map(owner).filter((dir): dir is string => Boolean(dir)),
  );
  const inventory = [...new Set(plan.unitTests)];
  const direct = inventory.filter((path) => touched.has(owner(path) ?? ""));
  const changed = new Set(plan.changedFiles);
  direct.sort(
    (a, b) => Number(changed.has(b)) - Number(changed.has(a)) || (a < b ? -1 : a > b ? 1 : 0),
  );
  // impact.ts returns at its first broad fence. Re-plan without release notes
  // so a changeset cannot hide a later workflow/root/schema fence.
  const changesetOnlyFull =
    plan.mode === "full" &&
    plan.reasons.length > 0 &&
    plan.reasons.every(
      (reason) => typeof reason?.path === "string" && reason.path.startsWith(".changeset/"),
    ) &&
    createImpactPlan(plan.changedFiles.filter((path) => !path.startsWith(".changeset/"))).mode ===
      "focused";
  const selectDirect = plan.mode === "focused" || changesetOnlyFull;
  const unitTests = selectDirect ? direct.slice(0, PR_UNIT_FILE_CAP) : [];
  return {
    ...plan,
    unitTests,
    prAdmissionUnits: {
      policy: "direct-packages-capped-v1",
      reason:
        plan.mode === "full" && !changesetOnlyFull
          ? "broad-impact-deferred-to-batch"
          : plan.mode === "docs"
            ? "docs-no-admission-units"
            : direct.length === 0
              ? "no-direct-package-units"
              : direct.length > PR_UNIT_FILE_CAP
                ? "direct-package-cap"
                : "direct-packages",
      cap: PR_UNIT_FILE_CAP,
      originalCount: inventory.length,
      directCount: direct.length,
      selectedCount: unitTests.length,
      deferredCount: inventory.length - unitTests.length,
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
