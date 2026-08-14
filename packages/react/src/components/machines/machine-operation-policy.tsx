import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { MachineOperationPolicy, UpdateMachineOperationPolicyRequest } from "@opengeni/sdk";

export type MachineOperationPolicyEditorProps = {
  policy: MachineOperationPolicy;
  supported: boolean;
  saving?: boolean | undefined;
  onSave: (request: UpdateMachineOperationPolicyRequest) => Promise<unknown> | unknown;
};

function fieldValue(value: number | null): string {
  return value === null ? "" : String(value);
}

function parseByteCount(label: string, value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a whole number of bytes or blank`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe-integer byte count or blank`);
  }
  return parsed;
}

/** Exact-byte editor for the optional per-enrollment command memory policy.
 * Blank values remain genuinely unrestricted; no UI-only quota is invented. */
export function MachineOperationPolicyEditor({
  policy,
  supported,
  saving = false,
  onSave,
}: MachineOperationPolicyEditorProps) {
  const [memoryMaxBytes, setMemoryMaxBytes] = useState(fieldValue(policy.memoryMaxBytes));
  const [memoryHighBytes, setMemoryHighBytes] = useState(fieldValue(policy.memoryHighBytes));
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setMemoryMaxBytes(fieldValue(policy.memoryMaxBytes));
    setMemoryHighBytes(fieldValue(policy.memoryHighBytes));
    setValidationError(null);
  }, [policy.memoryMaxBytes, policy.memoryHighBytes, policy.revision]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const max = parseByteCount("Hard ceiling", memoryMaxBytes);
      const high = parseByteCount("Reclaim threshold", memoryHighBytes);
      if (max !== null && high !== null && high > max) {
        throw new Error("Reclaim threshold cannot exceed the hard ceiling");
      }
      setValidationError(null);
      await onSave({
        memoryMaxBytes: max,
        memoryHighBytes: high,
        expectedRevision: policy.revision,
      });
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  };

  const configured = policy.memoryMaxBytes !== null || policy.memoryHighBytes !== null;

  return (
    <section
      data-machine-operation-policy
      className="rounded-og-lg border border-og-border bg-og-surface-1 p-4 shadow-og-sm"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-og-sm font-semibold text-og-fg">Command memory policy</h2>
        <p className="text-og-xs leading-relaxed text-og-fg-muted">
          Optional limits for contained exec and Git commands. Blank means unrestricted. The runner
          or host may apply a stricter explicit policy; browser, computer-use, and terminal
          capabilities remain unchanged.
        </p>
      </div>

      {configured && !supported ? (
        <div className="mt-3 flex gap-2 rounded-og-md border border-og-status-failed/40 bg-og-status-failed/5 p-3 text-og-xs text-og-status-failed">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            This runner cannot enforce the configured policy. Command execution fails closed until
            the runner is updated or the policy is cleared.
          </span>
        </div>
      ) : null}

      <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <label className="flex flex-col gap-1.5 text-og-xs text-og-fg-muted">
          Hard ceiling (bytes)
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={memoryMaxBytes}
            onChange={(event) => setMemoryMaxBytes(event.target.value)}
            placeholder="Unlimited"
            disabled={saving}
            className="min-h-9 rounded-og-sm border border-og-border bg-og-bg px-2.5 font-og-mono text-og-sm text-og-fg outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/50 disabled:opacity-60"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-og-xs text-og-fg-muted">
          Reclaim threshold (bytes)
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={memoryHighBytes}
            onChange={(event) => setMemoryHighBytes(event.target.value)}
            placeholder="Unlimited"
            disabled={saving}
            className="min-h-9 rounded-og-sm border border-og-border bg-og-bg px-2.5 font-og-mono text-og-sm text-og-fg outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/50 disabled:opacity-60"
          />
        </label>
        <div className="flex min-h-9 items-center justify-between gap-3 sm:col-span-2">
          <span
            role={validationError ? "alert" : undefined}
            className="text-og-xs text-og-status-failed"
          >
            {validationError}
          </span>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-og-sm bg-og-accent px-3 py-1.5 text-og-xs font-medium text-og-accent-fg transition-colors hover:bg-og-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
            Save policy
          </button>
        </div>
      </form>
    </section>
  );
}
