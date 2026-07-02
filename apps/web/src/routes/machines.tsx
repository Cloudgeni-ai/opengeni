// Machines: the workspace's bring-your-own-compute fleet — enrolled selfhosted
// machines, each with its connection-status pill, state badges, latest metrics
// (CPU/load/mem/disk/GPU), and an enroll affordance. The session-scoped attach/
// swap is exercised inside a session (the dock), where the active-sandbox pointer
// + the synthetic Modal group box are in scope. Here at the workspace level the
// fleet is the read-first overview + the zero-click enroll-token entry (with a
// manual device-flow approve kept as a secondary option).
import {
  EnrollmentDeviceFlow,
  MachinesDashboard,
  useMachines,
  type DeviceFlowPhase,
} from "@opengeni/react/machines";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  LaptopIcon,
  Loader2Icon,
  MonitorIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { apiBaseUrl } from "@/api";
import { PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { deviceVerificationUri, installOneLiner } from "@/lib/deployment";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppContext } from "@/context";

export function MachinesRoute({ workspaceId }: { workspaceId: string }) {
  const machines = useMachines({ pollIntervalMs: 5000 });
  const [enrollOpen, setEnrollOpen] = useState(false);

  // The install/approve URLs are deployment-relative: same origin as the API
  // (falling back to the page origin), never a hardcoded marketing domain.
  const origin = apiBaseUrl || (typeof window !== "undefined" ? window.location.origin : "");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
      <PageHeader
        icon={<LaptopIcon className="size-4" />}
        title="Machines"
        description="Your own computers, enrolled as agent sandboxes. Run the install one-liner on a machine and it appears here — driveable from any session alongside the Modal sandbox."
      />

      <div className="mt-5">
        <MachinesDashboard
          machines={machines.machines}
          activeSandboxId={machines.activeSandboxId}
          loading={machines.loading}
          error={machines.error}
          onRefresh={() => void machines.refresh()}
          onEnroll={() => setEnrollOpen(true)}
          {...(machines.canAttach
            ? { onAttach: (m) => void machines.attach(m.sandboxId), attachingSandboxId: machines.attachingSandboxId }
            : {})}
        />
      </div>

      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Enroll a machine</DialogTitle>
            <DialogDescription>
              Run a one-liner on the machine you want to share as an agent sandbox.
            </DialogDescription>
          </DialogHeader>
          {/* Gated on `enrollOpen` so the body mounts (and mints a fresh token)
              each time the dialog is opened, and unmounts on close — Radix already
              unmounts closed content, this just makes the mint-on-open explicit. */}
          {enrollOpen ? <EnrollDialogBody workspaceId={workspaceId} origin={origin} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type EnrollToken = { value: string; expiresAt: string; expiresInSeconds: number };

/**
 * The enroll dialog body. The PRIMARY path is zero-click: it mints a short-lived
 * enroll token (the `oget_` SECRET) on open and renders the install one-liner
 * that bakes it in — running that command enrolls the machine with no approval
 * step. An "Allow screen control" checkbox bakes the screen-control consent into
 * the minted token (toggling re-mints). The interactive device-flow approve is
 * kept as a SECONDARY "Approve manually instead" option (it is not required to
 * grant screen control — the checkbox above already covers that).
 */
function EnrollDialogBody({ workspaceId, origin }: { workspaceId: string; origin: string }) {
  const { client } = useAppContext();
  const [mode, setMode] = useState<"token" | "manual">("token");
  const [allowScreenControl, setAllowScreenControl] = useState(false);
  const [token, setToken] = useState<EnrollToken | null>(null);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Only the latest mint may apply its result — guards against an out-of-order
  // resolve when the user toggles screen control faster than the round-trip.
  const mintSeq = useRef(0);

  const mint = useCallback(
    async (screenControl: boolean) => {
      const seq = ++mintSeq.current;
      setMinting(true);
      setError(null);
      try {
        const result = await client.mintEnrollToken(workspaceId, { allowScreenControl: screenControl });
        if (seq !== mintSeq.current) {
          return;
        }
        setToken({ value: result.token, expiresAt: result.expiresAt, expiresInSeconds: result.expiresInSeconds });
        setCopied(false);
      } catch (err) {
        if (seq !== mintSeq.current) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setToken(null);
        toast.error("Could not create an enroll token", { description: message });
      } finally {
        if (seq === mintSeq.current) {
          setMinting(false);
        }
      }
    },
    [client, workspaceId],
  );

  // Mint on open and re-mint whenever the screen-control consent flips so the
  // baked-in token always matches the checkbox.
  useEffect(() => {
    void mint(allowScreenControl);
  }, [mint, allowScreenControl]);

  const command = token ? installOneLiner(origin, { enrollToken: token.value }) : "";

  function copyCommand() {
    if (!command) {
      return;
    }
    void navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success("Install command copied");
  }

  if (mode === "manual") {
    const installCommand = installOneLiner(origin, { workspaceId });
    const verificationUri = deviceVerificationUri(origin);
    return (
      <div className="flex flex-col gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-1 w-fit text-fg-muted"
          onClick={() => setMode("token")}
        >
          <ArrowLeftIcon className="size-4" />
          Back to one-click enroll
        </Button>
        <EnrollmentDeviceFlow
          // The agent mints the real code via the device-flow start; until the
          // user runs the one-liner this panel shows the install step + where to
          // approve. (A live code arrives once the agent calls /enrollments/start.)
          userCode="——————"
          verificationUri={verificationUri}
          installCommand={installCommand}
          phase={"pending" satisfies DeviceFlowPhase}
          onCopyInstall={() => void navigator.clipboard.writeText(installCommand)}
          className="border-0 shadow-none"
        />
        <p className="text-center text-2xs text-fg-muted">
          Screen control is granted on the approval page when you confirm the code.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] leading-4 text-fg-muted">
        Run this on the machine you want to share. It enrolls instantly as an agent sandbox — no approval step.
      </p>

      <label className="flex items-start gap-2 rounded-md border border-border bg-bg/40 px-2.5 py-2 text-[12px] leading-4 text-fg">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={allowScreenControl}
          disabled={minting}
          onChange={(event) => setAllowScreenControl(event.target.checked)}
        />
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 font-medium">
            <MonitorIcon className="size-3.5 text-fg-muted" />
            Allow screen control
          </span>
          <span className="text-2xs text-fg-muted">
            Let agents view and control this machine&apos;s screen (mouse + keyboard). Leave off for a headless sandbox.
          </span>
        </span>
      </label>

      <div className="flex items-start gap-2 rounded-md border border-status-waiting/40 bg-status-waiting/10 p-2.5 text-[12px] leading-4 text-status-waiting">
        <AlertTriangleIcon className="mt-px size-3.5 shrink-0" />
        <span>
          <span className="font-semibold">Secret — copy it now.</span> This command embeds a one-time enroll token that
          grants enrollment into this workspace until it expires. Anyone who has it can enroll a machine here.
        </span>
      </div>

      {minting ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-bg p-2.5 text-[12px] text-fg-muted">
          <Loader2Icon className="size-4 animate-spin" />
          Minting enroll token…
        </div>
      ) : error ? (
        <div className="flex flex-col gap-2 rounded-md border border-status-failed/40 bg-status-failed/10 p-2.5 text-[12px] leading-4 text-status-failed">
          <span>Could not create an enroll token. {error}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void mint(allowScreenControl)}
          >
            <TerminalIcon className="size-4" />
            Try again
          </Button>
        </div>
      ) : token ? (
        <>
          <div className="flex items-center justify-between rounded-md border border-border bg-surface-2/60 px-2.5 py-1.5 text-2xs text-fg-muted">
            <span>Expires {formatExpiry(token.expiresAt, token.expiresInSeconds)}</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => void mint(allowScreenControl)} disabled={minting}>
              Regenerate
            </Button>
          </div>
          <div className="rounded-md border border-border bg-bg p-2.5">
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-2xs text-fg">
              {command}
            </pre>
          </div>
          <Button type="button" variant="secondary" size="sm" className="w-full" onClick={copyCommand}>
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
            {copied ? "Copied" : "Copy install command"}
          </Button>
        </>
      ) : null}

      <div className="mt-1 border-t border-border pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-between text-fg-muted"
          onClick={() => setMode("manual")}
        >
          <span className="flex items-center gap-2">
            <TerminalIcon className="size-4" />
            Approve manually instead
          </span>
          <span className="text-2xs">device flow</span>
        </Button>
      </div>
    </div>
  );
}

/** Human-readable expiry from the mint response. Prefers the absolute time and
 * falls back to a relative "in N minutes" when the timestamp is unparseable. */
function formatExpiry(expiresAt: string, expiresInSeconds: number): string {
  const at = new Date(expiresAt);
  if (!Number.isNaN(at.getTime())) {
    return `at ${at.toLocaleString()}`;
  }
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
  return `in ~${minutes} min`;
}
