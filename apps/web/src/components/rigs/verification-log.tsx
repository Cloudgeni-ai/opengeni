// The verification evidence for an environment change: each check's outcome
// (command, result, expandable output) and the raw replay log. It shows
// exactly what ran in the clean sandbox and how each check exited.
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { RelativeTime } from "@/components/ui/relative-time";
import { StatusDot } from "@/components/ui/status-dot";
import { withOccurrenceKeys } from "@/lib/react-key";
import { cn } from "@/lib/utils";
import type { RigChangeVerification, RigCheckResult } from "@/types";

export function VerificationLog({ verification }: { verification: RigChangeVerification }) {
  const platformCheckResults = verification.platformCheckResults ?? [];
  const checkResults = verification.checkResults ?? [];
  const passed = typeof verification.passed === "boolean" ? verification.passed : undefined;
  const [logOpen, setLogOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {verification.startedAt || verification.finishedAt || passed !== undefined ? (
        <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-4.5 text-fg-muted">
          {passed !== undefined ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-fg">
              <StatusDot tone={passed ? "idle" : "failed"} size="sm" />
              {passed ? "All checks passed" : "A check failed"}
            </span>
          ) : null}
          {verification.finishedAt ? (
            <span>
              Finished <RelativeTime date={verification.finishedAt} inSentence />
            </span>
          ) : verification.startedAt ? (
            <span>
              Started <RelativeTime date={verification.startedAt} inSentence />
            </span>
          ) : null}
        </p>
      ) : null}

      {platformCheckResults.length > 0 ? (
        <CheckResults label="Platform checks" results={platformCheckResults} />
      ) : null}

      {checkResults.length > 0 ? (
        <CheckResults label="Environment checks" results={checkResults} />
      ) : null}

      {verification.log ? (
        <div className="min-w-0">
          <button
            type="button"
            aria-expanded={logOpen}
            onClick={() => setLogOpen((current) => !current)}
            className="inline-flex items-center gap-1.5 rounded-[6px] text-xs leading-4.5 font-medium text-fg-muted transition-colors duration-[120ms] hover:text-fg pointer-coarse:min-h-11"
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={cn("size-3.5 transition-transform", logOpen ? "" : "-rotate-90")}
            />
            Replay log
          </button>
          {logOpen ? (
            <pre className="mt-2 max-h-72 overflow-auto rounded-[10px] bg-surface-2 p-3 font-mono text-xs leading-[18px] text-fg-muted">
              {verification.log}
            </pre>
          ) : null}
        </div>
      ) : null}

      {platformCheckResults.length === 0 && checkResults.length === 0 && !verification.log ? (
        <p className="text-sm leading-5 text-fg-muted">No output was captured for this run.</p>
      ) : null}
    </div>
  );
}

function CheckResults({ label, results }: { label: string; results: RigCheckResult[] }) {
  return (
    <div className="min-w-0">
      <p className="text-xs leading-4.5 font-medium text-fg-muted">{label}</p>
      <ul className="m-0 mt-1 flex min-w-0 list-none flex-col divide-y divide-border p-0">
        {withOccurrenceKeys(
          results,
          (result) =>
            `${result.name}\u0000${result.command}\u0000${result.exitCode}\u0000${result.output}`,
        ).map(({ key, item: result }) => (
          <CheckResultRow key={key} result={result} />
        ))}
      </ul>
    </div>
  );
}

function CheckResultRow({ result }: { result: RigCheckResult }) {
  const [open, setOpen] = useState(false);
  const ok = result.exitCode === 0;
  const hasOutput = Boolean(result.output && result.output.length > 0);
  const outcome = ok
    ? "Passed"
    : result.exitCode === null
      ? "Didn't finish"
      : `Failed (exit ${result.exitCode})`;
  const content = (
    <>
      <StatusDot tone={ok ? "idle" : "failed"} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm leading-5 font-medium text-fg">
          {result.name || "Unnamed check"}
        </span>
        <span className="block truncate font-mono text-xs leading-[18px] text-fg-muted">
          {result.command}
        </span>
      </span>
      <span className={cn("shrink-0 text-xs leading-4.5", ok ? "text-fg-muted" : "text-danger")}>
        {outcome}
      </span>
      {hasOutput ? (
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-fg-subtle transition-transform",
            open ? "rotate-180" : "",
          )}
        />
      ) : null}
    </>
  );
  return (
    <li className="min-w-0">
      {hasOutput ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex w-full min-w-0 items-center gap-3 py-2 text-left pointer-coarse:min-h-11"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-3 py-2">{content}</div>
      )}
      {open && hasOutput ? (
        <pre className="mb-2 max-h-56 overflow-auto rounded-[10px] bg-surface-2 p-3 font-mono text-xs leading-[18px] text-fg-muted">
          {result.output}
        </pre>
      ) : null}
    </li>
  );
}
