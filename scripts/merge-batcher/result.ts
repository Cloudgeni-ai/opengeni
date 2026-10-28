import type { FailureDiagnostic, Manifest, Outcome } from "./model";

export interface VerifiedResult {
  outcome: Outcome;
  retryable: boolean;
  reason: string;
  infrastructureOnly?: true;
  failedClasses?: ("source" | "units")[];
  diagnostics?: FailureDiagnostic[];
}
interface Task {
  schemaVersion: 1;
  batchId: string;
  headSha: string;
  runId: string;
  runAttempt: number;
  job: string;
  exitCode: number;
  outcome: Outcome;
  retryable: boolean;
  startedAt: string;
  finishedAt: string;
  diagnostic?: unknown;
}
export function classifyExit(code: number): Pick<VerifiedResult, "outcome" | "retryable"> {
  if (code === 0) return { outcome: "success", retryable: false };
  if (code === 130 || code === 143) return { outcome: "cancelled", retryable: false };
  if (code < 0 || [75, 124, 126, 127].includes(code) || code >= 128)
    return { outcome: "infrastructure", retryable: false };
  return { outcome: "code_failure", retryable: code !== 70 };
}

function safePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 300 &&
    !path.startsWith("/") &&
    !/[\u0000-\u001f]/.test(path) &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}
// Untrusted failed-check evidence from a code-failure task. Malformed evidence
// is dropped, leaving the ordinary retry and bisection path.
export function verifyDiagnostic(job: string, raw: unknown): FailureDiagnostic | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.check !== "string" ||
    !/^[a-z0-9][a-z0-9:_.-]{0,63}$/.test(value.check) ||
    (value.check === "unit") !== /^unit-\d+$/.test(job) ||
    (value.check !== "unit" && job !== "source") ||
    !Array.isArray(value.paths) ||
    value.paths.length > 50 ||
    !value.paths.every(safePath) ||
    typeof value.excerpt !== "string"
  )
    return null;
  return {
    job,
    check: value.check,
    paths: [...new Set(value.paths)].sort(),
    excerpt: value.excerpt.replace(/[\u0000-\u001f\u007f`]/g, " ").slice(0, 300),
  };
}

// Independent of the candidate's aggregator implementation. A partial red can
// establish a failed assertion, but partial/malformed evidence can never be green.
export function verifyResult(
  raw: unknown,
  manifest: Manifest,
  runId: number,
  attempt: number,
): VerifiedResult | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (
    data.schemaVersion !== 1 ||
    data.batchId !== manifest.batchId ||
    data.headSha !== manifest.tipSha ||
    data.runId !== String(runId) ||
    data.runAttempt !== attempt ||
    typeof data.retryable !== "boolean" ||
    typeof data.reason !== "string" ||
    !Array.isArray(data.tasks) ||
    !Array.isArray(data.expectedJobs)
  )
    return null;
  const expected = data.expectedJobs;
  if (
    expected.length < 2 ||
    expected.length > 18 ||
    expected[0] !== "plan" ||
    expected[1] !== "source" ||
    expected.slice(2).some((name, index) => name !== `unit-${index}`)
  )
    return null;
  const jobs = data.jobs as Record<string, unknown> | null;
  if (
    !jobs ||
    typeof jobs !== "object" ||
    [jobs.plan, jobs.source, jobs.units].some((value) => typeof value !== "string")
  )
    return null;
  const seen = new Set<string>(),
    verified: Task[] = [];
  let incomplete = false;
  for (const item of data.tasks) {
    const task = item as Task | null;
    if (
      !task ||
      task.schemaVersion !== 1 ||
      task.batchId !== manifest.batchId ||
      task.headSha !== manifest.tipSha ||
      task.runId !== String(runId) ||
      task.runAttempt !== attempt ||
      !expected.includes(task.job) ||
      seen.has(task.job) ||
      !Number.isSafeInteger(task.exitCode) ||
      typeof task.retryable !== "boolean" ||
      !Number.isFinite(Date.parse(task.startedAt)) ||
      !Number.isFinite(Date.parse(task.finishedAt)) ||
      Date.parse(task.finishedAt) < Date.parse(task.startedAt)
    ) {
      incomplete = true;
      continue;
    }
    const classified = classifyExit(task.exitCode);
    if (classified.outcome !== task.outcome || classified.retryable !== task.retryable) {
      incomplete = true;
      continue;
    }
    seen.add(task.job);
    verified.push(task);
  }
  incomplete ||= expected.some((job) => !seen.has(String(job))) || jobs.plan !== "success";
  let outcome: Outcome = "success";
  if (Object.values(jobs).includes("cancelled") || verified.some((t) => t.outcome === "cancelled"))
    outcome = "cancelled";
  else if (verified.some((t) => t.outcome === "code_failure")) outcome = "code_failure";
  else if (
    incomplete ||
    verified.some((t) => t.outcome === "infrastructure") ||
    jobs.source !== "success" ||
    jobs.units !== (expected.length > 2 ? "success" : "skipped")
  )
    outcome = "infrastructure";
  const retryable =
    outcome === "code_failure" &&
    verified.filter((t) => t.outcome === "code_failure").every((t) => t.retryable);
  if (outcome === "cancelled")
    return {
      outcome,
      retryable: false,
      reason: "Verified cancellation wins over all code verdicts",
    };
  if (data.outcome !== outcome || data.retryable !== retryable) return null;
  const diagnostics =
    outcome === "code_failure"
      ? verified
          .filter((t) => t.outcome === "code_failure")
          .map((t) => verifyDiagnostic(t.job, t.diagnostic))
          .filter((d): d is FailureDiagnostic => d !== null)
      : [];
  return {
    outcome,
    retryable,
    reason: data.reason.slice(0, 2000),
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(outcome === "code_failure" &&
    !incomplete &&
    verified
      .filter((t) => t.outcome === "code_failure")
      .every((t) => t.job === "source" || /^unit-\d+$/.test(t.job))
      ? {
          failedClasses: [
            ...new Set(
              verified
                .filter((t) => t.outcome === "code_failure")
                .map((t): "source" | "units" => (t.job === "source" ? "source" : "units")),
            ),
          ],
        }
      : {}),
    ...(outcome === "infrastructure" &&
    !incomplete &&
    verified.some((t) => t.outcome === "infrastructure") &&
    verified.every((t) => t.outcome === "success" || t.outcome === "infrastructure")
      ? { infrastructureOnly: true as const }
      : {}),
  };
}
