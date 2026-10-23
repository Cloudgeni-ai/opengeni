import { digest, type Config } from "./model";

/** Operator-supplied evidence, not a claim that timestamps alone authenticate a provider.
 * The operator must retain the provider version receipts and drained STOP receipt.
 */
export function operatorOffIntervals(
  raw: string | undefined,
  config: Pick<Config, "repository" | "branchPrefix" | "mode">,
  now: string,
) {
  if (!raw) return [];
  const bad = () => {
    throw new Error("Invalid operator OFF accounting evidence; no credit applied");
  };
  if (raw.length > 262144 || !Number.isFinite(Date.parse(now))) return bad();
  let evidence: any;
  try {
    evidence = JSON.parse(raw);
  } catch {
    return bad();
  }
  if (
    evidence?.schema !== "batcher-operator-off/v1" ||
    evidence.repository !== config.repository ||
    evidence.branchPrefix !== config.branchPrefix ||
    evidence.mode !== config.mode ||
    typeof evidence.serviceUid !== "string" ||
    !evidence.serviceUid ||
    !Array.isArray(evidence.controls) ||
    evidence.controls.length < 2 ||
    evidence.controls.length > 256 ||
    !Array.isArray(evidence.drains) ||
    evidence.drains.length > 128
  )
    return bad();
  const controls = evidence.controls;
  const generations = new Set<string>();
  for (let i = 0; i < controls.length; i++) {
    const c = controls[i];
    if (
      !Number.isSafeInteger(c.version) ||
      c.version < 1 ||
      !Number.isFinite(Date.parse(c.at)) ||
      Date.parse(c.at) > Date.parse(now) ||
      !["stopped", "running"].includes(c.state) ||
      typeof c.generation !== "string" ||
      !/^(stop|start)-[a-zA-Z0-9-]{8,128}$/.test(c.generation) ||
      (c.state === "stopped") !== c.generation.startsWith("stop-") ||
      generations.has(c.generation)
    )
      return bad();
    if (
      i &&
      (c.version !== controls[i - 1].version + 1 ||
        Date.parse(c.at) <= Date.parse(controls[i - 1].at))
    )
      return bad();
    generations.add(c.generation);
  }
  const proof = digest(evidence),
    intervals: { from: string; to: string; evidenceDigest: string }[] = [];
  for (const d of evidence.drains) {
    const index = controls.findIndex((c: any) => c.version === d.controlVersion);
    const stop = controls[index];
    if (
      !stop ||
      stop.state !== "stopped" ||
      d.controlGeneration !== stop.generation ||
      d.serviceUid !== evidence.serviceUid ||
      d.manualZero !== true ||
      d.writerExited !== true ||
      d.stateStable !== true ||
      d.forced !== false ||
      !Number.isFinite(Date.parse(d.at)) ||
      Date.parse(d.at) < Date.parse(stop.at) ||
      Date.parse(d.at) > Date.parse(now)
    )
      return bad();
    const start = controls.slice(index + 1).find((c: any) => c.state === "running");
    // Unclosed intervals and drain completion after START prove no eligible OFF duration.
    if (!start || Date.parse(start.at) <= Date.parse(d.at)) continue;
    if (Date.parse(start.at) - Date.parse(d.at) > 7 * 86400000) return bad();
    intervals.push({ from: d.at, to: start.at, evidenceDigest: proof });
  }
  return intervals;
}
