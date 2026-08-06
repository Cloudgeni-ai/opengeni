// Machines: the workspace's bring-your-own-compute fleet — enrolled selfhosted
// machines, each with its connection-status pill, state badges, latest metrics
// (CPU/load/mem/disk/GPU), and an enroll affordance. The session-scoped attach/
// swap is exercised inside a session (the dock), where the active-sandbox pointer
// + the synthetic Modal group box are in scope. Here at the workspace level the
// fleet is the read-first overview + the zero-click enroll-token entry (with a
// manual device-flow approve kept as a secondary option).
import {
  EnrollmentDeviceFlow,
  MachineDetail,
  MachinesDashboard,
  connectionStatusForState,
  useMachines,
  type DeviceFlowPhase,
  type MetricSample,
  type MetricWindow,
} from "@opengeni/react/machines";
import { usePageLiveActivity } from "@opengeni/react";
import {
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

import { OpenGeniApiError } from "@opengeni/sdk";

import { apiBaseUrl } from "@/api";
import { PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Notice } from "@/components/ui/notice";
import { deviceVerificationUri, installOneLiner } from "@/lib/deployment";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppContext } from "@/context";
import type { MachineView } from "@opengeni/react/machines";

/** Copy to the clipboard and toast the outcome — clipboard access can be denied
 *  (permissions, insecure context), so failures surface instead of vanishing. */
async function copyToClipboard(text: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
    return true;
  } catch {
    toast.error("Couldn't copy to the clipboard", { description: "Copy it manually instead." });
    return false;
  }
}

export function MachinesRoute({ workspaceId }: { workspaceId: string }) {
  const machines = useMachines({ pollIntervalMs: 5000 });
  const pageLive = usePageLiveActivity();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<MachineView | null>(null);

  // The machine whose telemetry detail is open (by sandboxId), and its history.
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailWindow, setDetailWindow] = useState<MetricWindow>("1h");
  const [detailSeries, setDetailSeries] = useState<MetricSample[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  // Short (15m) history per machine for the card sparklines, keyed by sandboxId.
  const [cardSeries, setCardSeries] = useState<Record<string, MetricSample[]>>({});
  // A shared, slowly-ticking clock so "Live / updated Xago" stays honest without
  // re-rendering on every animation frame.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

  const { fetchSeries } = machines;
  const selectedMachine = detailId
    ? (machines.machines.find((m) => m.sandboxId === detailId) ?? null)
    : null;
  const selectedEnrollmentId = selectedMachine?.enrollmentId ?? null;

  // Fetch the compact card sparkline history for every enrolled machine. Keyed on
  // the SET of enrollment ids (not the 5s-polled array identity) + a 30s refresh,
  // so it doesn't refetch on every liveness poll.
  const enrolledKey = machines.machines
    .filter((m) => m.enrollmentId && !m.isSessionGroup)
    .map((m) => m.enrollmentId)
    .sort()
    .join(",");
  useEffect(() => {
    const enrolled = machines.machines.filter((m) => m.enrollmentId && !m.isSessionGroup);
    if (!pageLive || enrolled.length === 0) {
      setCardSeries({});
      return;
    }
    let cancelled = false;
    const load = async () => {
      const entries = await Promise.all(
        enrolled.map(async (m) => {
          try {
            return [m.sandboxId, await fetchSeries(m.enrollmentId!, "15m")] as const;
          } catch {
            return [m.sandboxId, [] as MetricSample[]] as const;
          }
        }),
      );
      if (!cancelled) setCardSeries(Object.fromEntries(entries));
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!cancelled) timer = setTimeout(() => void load().finally(schedule), 30_000);
    };
    void load().finally(schedule);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrolledKey, fetchSeries, pageLive]);

  // Fetch the open machine's detail history: on select, on window change, and on
  // a 10s refresh while open.
  useEffect(() => {
    if (!pageLive || !selectedEnrollmentId) {
      setDetailSeries([]);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    const load = async () => {
      try {
        const samples = await fetchSeries(selectedEnrollmentId, detailWindow);
        if (!cancelled) setDetailSeries(samples);
      } catch {
        if (!cancelled) setDetailSeries([]);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!cancelled) timer = setTimeout(() => void load().finally(schedule), 10_000);
    };
    void load().finally(schedule);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [selectedEnrollmentId, detailWindow, fetchSeries, pageLive]);

  // "Machine connected" moment: watch the polled fleet and, once a machine first
  // shows online (a fresh enrollment coming up, or a reconnect), toast it. The
  // first poll seeds the baseline silently so existing machines don't announce.
  const onlineSeenRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const online = new Set(
      machines.machines
        .filter(
          (machine) =>
            !machine.isSessionGroup && connectionStatusForState(machine.state) === "online",
        )
        .map((machine) => machine.sandboxId),
    );
    const previous = onlineSeenRef.current;
    if (previous) {
      for (const machine of machines.machines) {
        if (
          !machine.isSessionGroup &&
          connectionStatusForState(machine.state) === "online" &&
          !previous.has(machine.sandboxId)
        ) {
          toast.success(`${machine.name} connected`, {
            description: "It's ready to run sessions.",
          });
        }
      }
    }
    onlineSeenRef.current = online;
  }, [machines.machines]);

  // The install/approve URLs are deployment-relative: same origin as the API
  // (falling back to the page origin), never a hardcoded marketing domain.
  const origin = apiBaseUrl || (typeof window !== "undefined" ? window.location.origin : "");

  // A 404 from the machines API means the deployment doesn't enable connected
  // machines at all. That's a configuration fact, not a failure — render a calm
  // explanation instead of a red load error with a pointless retry (mirrors the
  // composer's handling in sessions-index).
  const featureUnavailable =
    machines.error instanceof OpenGeniApiError && machines.error.status === 404;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
      <PageHeader
        icon={<LaptopIcon className="size-4" />}
        title="Machines"
        description="Your own computers, connected as agent sandboxes. One agent can serve this workspace alongside any other OpenGeni workspaces or deployments already connected to the machine."
      />

      <div className="mt-5">
        {featureUnavailable ? (
          <Notice tone="muted">
            Connected machines aren't enabled on this deployment. Sessions run on the managed
            sandbox.
          </Notice>
        ) : selectedMachine ? (
          <MachineDetail
            machine={selectedMachine}
            series={detailSeries}
            window={detailWindow}
            onWindowChange={setDetailWindow}
            loadingSeries={detailLoading}
            onBack={() => setDetailId(null)}
            {...(machines.canRemove
              ? { onRemove: (machine: MachineView) => setRemoveTarget(machine) }
              : {})}
            now={now}
          />
        ) : (
          <MachinesDashboard
            machines={machines.machines}
            activeSandboxId={machines.activeSandboxId}
            loading={machines.loading}
            error={machines.error}
            seriesByMachine={cardSeries}
            onOpenDetail={(m) => setDetailId(m.sandboxId)}
            now={now}
            onRefresh={() => void machines.refresh()}
            onEnroll={() => setEnrollOpen(true)}
            {...(machines.canAttach
              ? {
                  onAttach: (m) => void machines.attach(m.sandboxId),
                  attachingSandboxId: machines.attachingSandboxId,
                }
              : {})}
          />
        )}
      </div>

      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect a machine</DialogTitle>
            <DialogDescription>
              Run one command to install or update the agent and add this workspace. Existing
              OpenGeni connections stay intact.
            </DialogDescription>
          </DialogHeader>
          {/* Gated on `enrollOpen` so the body mounts (and mints a fresh token)
              each time the dialog is opened, and unmounts on close — Radix already
              unmounts closed content, this just makes the mint-on-open explicit. */}
          {enrollOpen ? <EnrollDialogBody workspaceId={workspaceId} origin={origin} /> : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={removeTarget ? `Remove machine “${removeTarget.name}”?` : "Remove machine?"}
        description="Access will be revoked immediately while the machine is offline. Its session, route, lease, archive, and audit history will be kept; reconnecting later requires a fresh human-approved enrollment."
        confirmLabel="Remove machine"
        onConfirm={async () => {
          const target = removeTarget;
          if (!target?.enrollmentId) return false;
          const result = await machines.remove(target.enrollmentId);
          if (!result) {
            toast.error("Machine removal is unavailable", {
              description: "Refresh the page and try again.",
            });
            return false;
          }
          if (result.outcome === "blocked") {
            toast.error(result.message, { description: result.action });
            return false;
          }
          toast.success(
            result.outcome === "already_removed"
              ? `${target.name} was already removed`
              : `${target.name} removed`,
            { description: "It will disappear from the active machine list." },
          );
          setRemoveTarget(null);
          setDetailId(null);
          return true;
        }}
      >
        {removeTarget ? (
          <div className="space-y-2 rounded-og-md border border-og-border bg-og-surface-2/40 px-3 py-2 text-og-sm text-og-fg-muted">
            <p>
              <span className="font-medium text-og-fg">Machine:</span> {removeTarget.name}
            </p>
            <p>
              <span className="font-medium text-og-fg">Last seen:</span>{" "}
              {removeTarget.lastSeenAt
                ? new Date(removeTarget.lastSeenAt).toLocaleString()
                : "Never connected"}
            </p>
          </div>
        ) : null}
      </ConfirmDialog>
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
        const result = await client.mintEnrollToken(workspaceId, {
          allowScreenControl: screenControl,
        });
        if (seq !== mintSeq.current) {
          return;
        }
        setToken({
          value: result.token,
          expiresAt: result.expiresAt,
          expiresInSeconds: result.expiresInSeconds,
        });
        setCopied(false);
      } catch (err) {
        if (seq !== mintSeq.current) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setToken(null);
        toast.error("Could not create a connect command", { description: message });
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
    void copyToClipboard(command, "Connect command copied").then((ok) => {
      if (ok) {
        setCopied(true);
      }
    });
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
          Back to one-command setup
        </Button>
        <EnrollmentDeviceFlow
          // The agent mints the real code via the device-flow start; until the
          // user runs the one-liner this panel shows the install step + where to
          // approve. (A live code arrives once the agent calls /enrollments/start.)
          userCode="——————"
          verificationUri={verificationUri}
          installCommand={installCommand}
          phase={"pending" satisfies DeviceFlowPhase}
          onCopyInstall={() => void copyToClipboard(installCommand, "Connect command copied")}
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
      <p className="text-xs leading-4 text-fg-muted">
        Run this on the machine you want to share. Agents v0.1.10+ add the workspace live within a
        few seconds; if the command upgrades an older running agent, restart that agent once. Other
        workspaces stay configured.
      </p>

      <label className="flex items-start gap-2 rounded-md border border-border bg-bg/40 px-2.5 py-2 text-xs leading-4 text-fg">
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
            Let agents view and control this machine&apos;s screen (mouse + keyboard). Leave off for
            a headless sandbox.
          </span>
        </span>
      </label>

      <Notice tone="waiting" title="Secret — copy it now">
        This command embeds a one-time token that can connect a machine to this workspace until it
        expires. Anyone who has it can connect a machine here.
      </Notice>

      {minting ? (
        <Notice tone="muted" icon={<Loader2Icon className="size-4 animate-spin" />}>
          Preparing secure connect command…
        </Notice>
      ) : error ? (
        <Notice
          tone="failed"
          title="Could not create a connect command"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void mint(allowScreenControl)}
            >
              <TerminalIcon className="size-4" />
              Try again
            </Button>
          }
        >
          {error}
        </Notice>
      ) : token ? (
        <>
          <div className="flex items-center justify-between rounded-md border border-border bg-surface-2/60 px-2.5 py-1.5 text-2xs text-fg-muted">
            <span>Expires {formatExpiry(token.expiresAt, token.expiresInSeconds)}</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void mint(allowScreenControl)}
              disabled={minting}
            >
              Regenerate
            </Button>
          </div>
          <div className="rounded-md border border-border bg-bg p-2.5">
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-2xs text-fg">
              {command}
            </pre>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={copyCommand}
          >
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
            {copied ? "Copied" : "Copy connect command"}
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
