// Machines: the workspace's bring-your-own-compute fleet — enrolled selfhosted
// machines, each with its connection-status pill, state badges, latest metrics
// (CPU/load/mem/disk/GPU), and an enroll affordance. The session-scoped attach/
// swap is exercised inside a session (the dock), where the active-sandbox pointer
// + the synthetic Modal group box are in scope. Here at the workspace level the
// fleet is the read-first overview + the device-flow enrollment entry.
import {
  EnrollmentDeviceFlow,
  MachinesDashboard,
  useMachines,
  type DeviceFlowPhase,
} from "@opengeni/react";
import { AlertTriangleIcon, CheckIcon, CopyIcon, LaptopIcon, Loader2Icon, TerminalIcon } from "lucide-react";
import { useState } from "react";
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
  // The default (interactive) one-liner now carries the workspace id so the user
  // never hand-types the UUID; the agent prints a code to approve at /device.
  const installCommand = installOneLiner(origin, { workspaceId });
  const verificationUri = deviceVerificationUri(origin);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
      <PageHeader
        icon={<LaptopIcon className="size-4" />}
        title="Machines"
        description="Your own computers, enrolled as agent sandboxes. Run the install one-liner on a machine, approve the loud whole-machine consent, and it appears here — driveable from any session alongside the Modal sandbox."
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
              Run the install one-liner on the machine you want to share. It prints a short code; confirm it on the approval
              page to grant access.
            </DialogDescription>
          </DialogHeader>
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
          <HeadlessEnrollSection workspaceId={workspaceId} origin={origin} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * A2.5 — the headless / CI / fleet enroll path. Visually separated from the
 * interactive one-liner above so users aren't confused about which to run. It
 * mints a short-lived enroll token (the `oget_` SECRET — shown once, never
 * re-readable) and renders the headless one-liner that bakes it in, with a loud
 * copy-now warning + the expiry. The token IS the grant — machines that run this
 * one-liner enroll with zero approve clicks.
 */
function HeadlessEnrollSection({ workspaceId, origin }: { workspaceId: string; origin: string }) {
  const { client } = useAppContext();
  const [open, setOpen] = useState(false);
  const [minting, setMinting] = useState(false);
  const [token, setToken] = useState<{ value: string; expiresAt: string; expiresInSeconds: number } | null>(null);
  const [copied, setCopied] = useState(false);

  async function mint() {
    setMinting(true);
    try {
      // Headless tokens never carry screen-control consent (no human at the
      // approve page to make that call) — `false` is the only safe default.
      const result = await client.mintEnrollToken(workspaceId, { allowScreenControl: false });
      setToken({ value: result.token, expiresAt: result.expiresAt, expiresInSeconds: result.expiresInSeconds });
      setCopied(false);
    } catch (error) {
      toast.error("Could not create an enroll token", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setMinting(false);
    }
  }

  const headlessCommand = token ? installOneLiner(origin, { enrollToken: token.value }) : "";

  function copyCommand() {
    if (!headlessCommand) {
      return;
    }
    void navigator.clipboard.writeText(headlessCommand);
    setCopied(true);
    toast.success("Headless install command copied");
  }

  if (!open) {
    return (
      <div className="mt-1 border-t border-[color:var(--color-border)] pt-3">
        <Button type="button" variant="ghost" size="sm" className="w-full justify-start text-[color:var(--color-fg-muted)]" onClick={() => setOpen(true)}>
          <TerminalIcon className="size-4" />
          Advanced: headless / CI enrollment
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-col gap-3 border-t border-[color:var(--color-border)] pt-3">
      <div>
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-fg)]">
          <TerminalIcon className="size-3.5 text-[color:var(--color-fg-muted)]" />
          Headless / CI enrollment
        </h3>
        <p className="mt-1 text-[12px] leading-4 text-[color:var(--color-fg-muted)]">
          Mint a short-lived token to enroll a machine with no approval click — for fleet rollouts and CI. Use the
          interactive one-liner above for a normal machine.
        </p>
      </div>

      {token ? (
        <>
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[12px] leading-4 text-amber-200">
            <AlertTriangleIcon className="mt-px size-3.5 shrink-0" />
            <span>
              <span className="font-semibold">Secret — copy it now.</span> This token grants enrollment into this
              workspace until it expires and won't be shown again. Anyone who has it can enroll a machine here.
            </span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/60 px-2.5 py-1.5 text-[11px] text-[color:var(--color-fg-muted)]">
            <span>Expires {formatExpiry(token.expiresAt, token.expiresInSeconds)}</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => void mint()} disabled={minting}>
              {minting ? <Loader2Icon className="size-3 animate-spin" /> : null}
              Regenerate
            </Button>
          </div>
          <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-2.5">
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-[color:var(--color-fg)]">
              {headlessCommand}
            </pre>
          </div>
          <Button type="button" variant="secondary" size="sm" className="w-full" onClick={copyCommand}>
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
            {copied ? "Copied" : "Copy headless install command"}
          </Button>
        </>
      ) : (
        <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => void mint()} disabled={minting}>
          {minting ? <Loader2Icon className="size-4 animate-spin" /> : <TerminalIcon className="size-4" />}
          Generate enroll token
        </Button>
      )}
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
