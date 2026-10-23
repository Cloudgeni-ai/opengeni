import type { CodexConnectionStatus, CodexConnectStart } from "@opengeni/sdk";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { client } from "../lib/app-api";

/** ChatGPT (Codex) sign-in with a device code, so agents have a smart model to run on. */
export function CodexConnect({
  workspaceId,
  status,
  onConnected,
}: {
  workspaceId: string;
  status: CodexConnectionStatus | null;
  onConnected: () => void;
}) {
  const [flow, setFlow] = useState<CodexConnectStart | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "expired" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cancelled = useRef(false);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const start = async () => {
    setPhase("starting");
    setError(null);
    try {
      const started = await client.codexConnectStart(workspaceId);
      setFlow(started);
      setPhase("waiting");
      const interval = Math.max(3, started.intervalSeconds) * 1000;
      while (!cancelled.current) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        const result = await client.codexConnectPoll(workspaceId, started.state);
        if (result.status === "connected") {
          setFlow(null);
          setPhase("idle");
          onConnected();
          return;
        }
        if (result.status === "expired") {
          setPhase("expired");
          return;
        }
      }
    } catch {
      setPhase("error");
      setError("Couldn't reach ChatGPT. Try again in a moment.");
    }
  };

  if (status?.connected) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] p-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
          <Check size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">ChatGPT is connected</div>
          <div className="text-xs text-[var(--app-muted)]">
            {status.activeAccount?.label ?? "Your subscription"}
            {status.plan ? ` · ${status.plan}` : ""}
            {status.accountCount && status.accountCount > 1
              ? ` · ${status.accountCount} accounts`
              : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void start()}
          className="rounded-full border border-[var(--app-border)] px-3 py-1.5 text-xs"
        >
          Add account
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] p-4">
      <div className="text-sm font-semibold">Connect ChatGPT</div>
      <p className="mt-1 text-xs text-[var(--app-muted)]">
        Agents run on your ChatGPT subscription. Sign in once and every agent can use it.
      </p>
      {phase === "waiting" && flow ? (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-[var(--app-fg)]">
            Open the ChatGPT page, sign in, and enter this code:
          </p>
          <div className="flex items-center gap-2">
            <code className="rounded-xl bg-[var(--app-hover)] px-3 py-2 font-mono text-lg tracking-widest">
              {flow.userCode}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(flow.userCode).then(() => setCopied(true));
              }}
              className="rounded-lg p-2 text-[var(--app-muted)] hover:bg-[var(--app-hover)]"
              aria-label="Copy code"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <a
            href={flow.verificationUri}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--app-accent)] px-3.5 py-2 text-sm font-medium text-white"
          >
            Open ChatGPT sign-in <ExternalLink size={14} />
          </a>
          <div className="flex items-center gap-2 text-xs text-[var(--app-muted)]">
            <Loader2 size={13} className="animate-spin" /> This updates by itself once you're done.
          </div>
        </div>
      ) : (
        <div className="mt-3">
          {phase === "expired" ? (
            <p className="mb-2 text-xs text-amber-600">That code expired. Try again.</p>
          ) : null}
          {error ? <p className="mb-2 text-xs text-red-600">{error}</p> : null}
          <button
            type="button"
            disabled={phase === "starting"}
            onClick={() => void start()}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--app-accent)] px-3.5 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {phase === "starting" ? <Loader2 size={14} className="animate-spin" /> : null}
            Connect
          </button>
        </div>
      )}
    </div>
  );
}
