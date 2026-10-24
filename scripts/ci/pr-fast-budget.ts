export type FastObservation = {
  id: number;
  kind: "modern-pr" | "legacy-pr" | "main" | "batch" | "other";
  jobs: { name: string; status: string; conclusion: string | null }[];
  legacyGroup?: string;
};

// One fast-check runner per permit, plus the serialized admission runner.
export const FAST_PERMITS = 4;
export const FAST_ADMISSION = "PR fast admission";
const active = new Set(["queued", "in_progress", "requested", "pending"]);
const known = new Set([...active, "waiting", "completed"]);

export function fastBudget(observations: FastObservation[], ownRun: number) {
  let permits = 0,
    main = 0,
    batch = 0,
    other = 0;
  const legacy = new Set<string>();
  const held = (reason: string) => ({ allowed: false, reason });
  for (const observation of observations) {
    if (observation.id === ownRun) continue;
    if (observation.jobs.some((j) => !known.has(j.status))) return held("Unknown job status");
    const demand = observation.jobs.filter((j) => active.has(j.status)).length;
    if (observation.kind === "modern-pr") {
      const admission = observation.jobs.filter((j) => j.name === FAST_ADMISSION);
      if (admission.length > 1) return held("Ambiguous admission job");
      if (!admission.length) {
        if (observation.jobs.length) return held("Missing admission identity");
        continue; // Proven modern workflow cannot start checks before its locked admission.
      }
      const job = admission[0]!;
      if (job.status === "queued" || job.status === "pending" || job.status === "requested")
        continue;
      // Reserve through the workflow's terminal state, including propagation
      // gaps before the downstream job appears. An earlier admission still
      // reported running is conservatively a permit, not spare capacity.
      if (job.status !== "completed" || job.conclusion === "success") permits++;
      else if (demand) permits++;
    } else if (observation.kind === "legacy-pr") {
      if (!observation.legacyGroup) return held("Unknown legacy concurrency");
      if (demand > 3) return held("Legacy job demand exceeds verified topology");
      legacy.add(observation.legacyGroup);
    } else if (observation.kind === "main") {
      // Empty main runs can fan out; reserve the established full-main floor.
      main += observation.jobs.length <= 3 ? Math.max(30, demand) : demand;
    } else if (observation.kind === "batch") {
      batch += Math.max(18, demand);
    } else {
      if (!observation.jobs.length) return held("Unknown pre-fanout demand");
      other += demand;
    }
  }
  if (permits >= FAST_PERMITS) return held("Four fast permits outstanding");
  // Verified legacy topology has peak contracts + two unit runners. Each
  // provider concurrency group contributes once, including its pending queue.
  const reserved =
    28 + Math.max(9, main) + Math.max(18, batch) + other + legacy.size * 3 + permits + 1 + 1;
  return {
    allowed: reserved <= 60,
    reason: `Reserved ${reserved}/60 jobs; ${permits} fast permits; ${legacy.size} legacy groups`,
  };
}

export function classifyPrWorkflow(workflow: any): "modern-pr" | "legacy-pr" | null {
  if (!workflow || typeof workflow !== "object" || !workflow.jobs) return null;
  const jobs = workflow.jobs;
  if (Object.values(jobs).some((job: any) => job.uses || job["runs-on"] !== "ubuntu-latest"))
    return null;
  if (
    Object.keys(jobs).sort().join() === "fast,plan,ready" &&
    workflow.concurrency?.group ===
      "pr-ci-${{ github.event.pull_request.number || inputs.pr_number }}" &&
    jobs.plan.name === FAST_ADMISSION &&
    jobs.plan.concurrency?.group === "pr-ci-admission-v3" &&
    jobs.plan.concurrency?.["cancel-in-progress"] === false &&
    jobs.plan.steps?.some((s: any) => s.run === "bun scripts/ci/github-pr-ci.ts admit-fast") &&
    jobs.fast.needs === "plan" &&
    !jobs.fast.strategy &&
    !jobs.plan.strategy &&
    !jobs.ready.strategy &&
    JSON.stringify(jobs.ready.needs) === JSON.stringify(["plan", "fast"])
  )
    return "modern-pr";
  if (
    Object.keys(jobs).sort().join() !== "contracts,plan,ready,units" ||
    jobs.contracts.needs !== "plan" ||
    jobs.units.needs !== "plan" ||
    jobs.contracts.strategy ||
    jobs.plan.strategy ||
    jobs.ready.strategy ||
    jobs.units.strategy?.matrix?.include !== "${{ fromJSON(needs.plan.outputs.unit_matrix) }}" ||
    !jobs.plan.steps?.some((s: any) =>
      String(s.run).includes('unit_matrix=[{"index":0,"total":2},{"index":1,"total":2}]'),
    ) ||
    JSON.stringify(jobs.ready.needs) !== JSON.stringify(["plan", "contracts", "units"])
  )
    return null;
  return workflow.concurrency?.group === "pr-ci-fanout" ? "legacy-pr" : null;
}
