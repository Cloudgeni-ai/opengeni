import {
  ATTESTED_SKIPPED_LANES,
  attestedMainRun,
  type BaseCiEvidence,
  type BaseJobClass,
  type Run,
} from "./model";

/**
 * Main CI jobs in the `lanes` class: every gating lane Batch CI runs through
 * its `Main CI lanes` call, including that call's own source contracts job.
 * Unit shards keep their own class (Batch skips them inside the call), and
 * aggregates and main-only release jobs are excluded.
 */
export function mainLaneJob(name: string): boolean {
  return (
    ATTESTED_SKIPPED_LANES.some((lane) => lane !== "Unit tests (shard" && name.startsWith(lane)) ||
    name === "Deployment artifacts" ||
    name.startsWith("Build exact artifact runtime inputs") ||
    /^Build [A-Za-z -]+ workload image$/.test(name)
  );
}

/** Static job-class mapping, not an identical assertion/fingerprint claim. */
export function baseJobClasses(
  rows: unknown[],
  runId: number,
): NonNullable<BaseCiEvidence["classes"]> {
  const unknown = { source: "unknown", units: "unknown", lanes: "unknown" } as const;
  const ids = new Set<number>();
  const jobs: { name: string; status: string; conclusion: string | null }[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") return unknown;
    const job = row as Record<string, unknown>;
    if (
      !Number.isSafeInteger(job.id) ||
      Number(job.id) < 1 ||
      ids.has(Number(job.id)) ||
      job.run_id !== runId ||
      typeof job.name !== "string" ||
      typeof job.status !== "string" ||
      (job.conclusion !== null && typeof job.conclusion !== "string")
    )
      return unknown;
    ids.add(Number(job.id));
    jobs.push({ name: job.name, status: job.status, conclusion: job.conclusion });
  }
  // A Batch-attested main push skips its test lanes because a trusted Batch CI
  // attempt passed source, units and every main lane on this exact tree; that
  // verdict is the base's class. Any non-skipped lane is not attested.
  if (attestedMainRun(rows)) return { source: "green", units: "green", lanes: "green" };
  const verdict = (selected: typeof jobs): "green" | "red" | "unknown" => {
    if (
      !selected.length ||
      selected.some(
        (j) => j.status !== "completed" || !["success", "failure"].includes(j.conclusion ?? ""),
      )
    )
      return "unknown";
    return selected.some((j) => j.conclusion === "failure") ? "red" : "green";
  };
  const source = jobs.filter((j) => j.name === "Source and type contracts");
  const units = jobs.filter((j) => /^Unit tests \(shard [1-9]\d*\/[1-9]\d*\)$/.test(j.name));
  const shards = units
    .map((j) => j.name.match(/shard (\d+)\/(\d+)/)!)
    .map((m) => [Number(m[1]), Number(m[2])] as const);
  const count = shards[0]?.[1] ?? 0;
  const complete =
    count > 0 &&
    count === shards.length &&
    shards.every(([index, total]) => total === count && index <= count) &&
    new Set(shards.map(([index]) => index)).size === count;
  // Impact-skipped lanes are neutral; a job waiting for release approval holds
  // no verdict yet. Any other pending or inconclusive lane job is unknown.
  const lanes = jobs.filter((j) => mainLaneJob(j.name) && j.status !== "waiting");
  const lanesVerdict = (): "green" | "red" | "unknown" => {
    if (lanes.some((j) => j.status === "completed" && j.conclusion === "failure")) return "red";
    const ran = lanes.filter((j) => j.conclusion !== "skipped");
    // Source contracts alone never prove the lane fan-out ran: a real main
    // run lists every lane job, skipped or not.
    if (
      !lanes.some((j) => j.name !== "Source and type contracts") ||
      !ran.length ||
      ran.some((j) => j.status !== "completed" || j.conclusion !== "success") ||
      lanes.some((j) => j.status !== "completed")
    )
      return "unknown";
    return "green";
  };
  return {
    source: source.length === 1 ? verdict(source) : "unknown",
    units: complete ? verdict(units) : "unknown",
    lanes: lanesVerdict(),
  };
}

export function failedBaseHold(
  run: Run,
  baseSha: string,
  base: BaseCiEvidence | undefined,
): string | null {
  if (
    !base ||
    base.sha !== baseSha ||
    !Number.isSafeInteger(base.runId) ||
    base.runId! < 1 ||
    !Number.isSafeInteger(base.attempt) ||
    base.attempt! < 1 ||
    base.status === "unknown"
  )
    return "failed cohort waits for conclusive exact-base comparison; no retry, split or parking";
  if (base.status === "green") return null;
  if (
    !run.failedClasses?.length ||
    run.failedClasses.some(
      (kind: BaseJobClass) =>
        !["source", "units", "lanes"].includes(kind) || base.classes?.[kind] !== "green",
    )
  )
    return "failed cohort has red or unknown relevant exact-base job class; no retry, split or parking";
  return null;
}
