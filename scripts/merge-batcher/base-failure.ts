import { attestedMainRun, type BaseCiEvidence, type Run } from "./model";

/** Static job-class mapping, not an identical assertion/fingerprint claim. */
export function baseJobClasses(
  rows: unknown[],
  runId: number,
): NonNullable<BaseCiEvidence["classes"]> {
  const unknown = { source: "unknown", units: "unknown" } as const;
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
  // A Batch-attested main push skips its source and unit lanes because a
  // trusted Batch CI attempt passed both on this exact tree; that verdict is
  // the base's source and unit class. Any non-skipped lane is not attested.
  if (attestedMainRun(rows)) return { source: "green", units: "green" };
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
  return {
    source: source.length === 1 ? verdict(source) : "unknown",
    units: complete ? verdict(units) : "unknown",
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
      (kind) => !["source", "units"].includes(kind) || base.classes?.[kind] !== "green",
    )
  )
    return "failed cohort has red or unknown relevant exact-base job class; no retry, split or parking";
  return null;
}
