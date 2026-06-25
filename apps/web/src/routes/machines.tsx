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
import { LaptopIcon } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/common";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function MachinesRoute({ workspaceId }: { workspaceId: string }) {
  const machines = useMachines({ pollIntervalMs: 5000 });
  const [enrollOpen, setEnrollOpen] = useState(false);
  void workspaceId;

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
            verificationUri="https://get.opengeni.ai/device"
            installCommand="curl -fsSL https://get.opengeni.ai/install.sh | sh"
            phase={"pending" satisfies DeviceFlowPhase}
            className="border-0 shadow-none"
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
