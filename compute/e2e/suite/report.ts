// The suite's results and their table, written by run.ts on the stack VM and
// rewritten by verify.ts once the hosts' journals have been read.

export type Status = "pass" | "fail" | "skip" | "n/a";

/** What a check claims that only a host's journal can show: that the
 * sandbox reached `level` (a completed step to it, the last one) between
 * `from` and `to`, when the next request woke it. */
export type LevelProof = { kind: "level"; sandbox: string; level: string; from: string; to: string };

/** That the host checkpointed the running sandbox (a completed checkpoint
 * step) between `from` and `to`, while the check's streams stayed open. */
export type CheckpointProof = { kind: "checkpoint"; sandbox: string; from: string; to: string };

export type Proof = LevelProof | CheckpointProof;

export type Result = {
  id: string;
  title: string;
  status: Status;
  detail: string;
  seconds: number;
  proofs?: Proof[];
};

export type Meta = {
  opengeni: string;
  compute: string;
  model: string;
  started: string;
  finished: string;
  /** What the guests' consoles show (verify.ts), for the record. */
  notes?: string[];
};

export const counts = (results: Result[], status: Status) => results.filter((r) => r.status === status).length;

export function render(meta: Meta, results: Result[], verified: boolean): string {
  const proofs = results.some((r) => r.proofs?.length);
  return [
    `Opengeni ${meta.opengeni}, compute ${meta.compute.slice(0, 12)}, model ${meta.model}, ${meta.finished}`,
    "",
    `${counts(results, "pass")} passed, ${counts(results, "fail")} failed, ${counts(results, "skip")} skipped, ` +
      `${counts(results, "n/a")} not applicable.`,
    ...(proofs && !verified
      ? ["", "Not yet verified: the sleep and checkpoint checks pass only once the hosts' journals show each level or checkpoint (env.sh suite does that)."]
      : []),
    "",
    `| check | result | seconds | detail |`,
    `| --- | --- | ---: | --- |`,
    ...results.map(
      (r) => `| ${r.id} | ${r.status} | ${r.seconds.toFixed(1)} | ${r.detail.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
    ),
    ...(meta.notes?.length ? ["", ...meta.notes.map((note) => `- ${note}`)] : []),
    "",
  ].join("\n");
}
