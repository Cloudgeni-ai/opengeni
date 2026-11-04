import type { MachineView, Session, SessionMachineAccess } from "@opengeni/sdk";
import { SessionAdmissionNotice, SessionMachineAccessNotice } from "@opengeni/react/session-ui";
import { Button } from "@opengeni/react/ui/button";

import { KitSection, StateCell, StatesGrid } from "../kit";
import { showPart } from "./chat-shared";

/* ----------------------------------------------------------------------------
   A saved message that can't start: the notice above the composer that says
   why and offers the one way forward. The real notice renders against fixture
   sessions and machine projections; moving and rechecking resolve at once.
   -------------------------------------------------------------------------- */

function blocked(reason: string, activeSandboxId = "laptop"): Session {
  return {
    id: "session-kit",
    workspaceId: "ws-kit",
    status: "requires_action",
    activeSandboxId,
    effectiveControl: { state: "active", controlVersion: 4, controlEtag: "etag-kit" },
    admissionBlock: {
      reason,
      sqlState: "OG002",
      retryPolicy: "explicit_recheck",
      blockedAt: "2026-10-28T11:52:00Z",
    },
  } as unknown as Session;
}

function access(overrides: Partial<SessionMachineAccess> = {}): SessionMachineAccess {
  return {
    sandboxId: "laptop",
    machineName: "Laptop",
    ownerName: "Kari",
    isOwner: true,
    queuedTurnBlocked: false,
    queuedTurnNotApprovedHere: true,
    queuedTurnApprovedMachines: [{ sandboxId: "server", machineName: "Home server" }],
    ...overrides,
  };
}

function machine(state: string): MachineView {
  return {
    sandboxId: "server",
    name: "Home server",
    scope: "user",
    state,
    active: false,
    isSessionGroup: false,
  } as unknown as MachineView;
}

const STATES: {
  part: string;
  label: string;
  session: Session;
  access: SessionMachineAccess | null;
  machines?: MachineView[];
  picker?: boolean;
}[] = [
  {
    part: "run",
    label: "Sent for another of your machines",
    session: blocked("personal_resource_grant_required"),
    access: access(),
    machines: [machine("online")],
  },
  {
    part: "offline",
    label: "That machine is offline",
    session: blocked("personal_resource_grant_required"),
    access: access(),
    machines: [machine("offline")],
  },
  {
    part: "moved",
    label: "Sent before the chat moved to your machine",
    session: blocked("personal_resource_grant_required"),
    access: access({ queuedTurnApprovedMachines: [] }),
    picker: true,
  },
  {
    part: "others",
    label: "Someone else's message, seen by another member",
    session: blocked("personal_resource_grant_required"),
    access: access({ isOwner: false, queuedTurnApprovedMachines: [] }),
  },
  {
    part: "generic",
    label: "Another resource isn't approved",
    session: blocked("personal_resource_grant_required", "cloud"),
    access: null,
  },
];

/* Before anyone sends, in a chat shared with the workspace. */
const BEFORE_SENDING: { part: string; label: string; access: SessionMachineAccess }[] = [
  {
    part: "own-shared",
    label: "Your own machine, in a shared chat",
    access: access({ queuedTurnNotApprovedHere: false, queuedTurnApprovedMachines: [] }),
  },
  {
    part: "others-shared",
    label: "Someone else's machine, in a shared chat",
    access: access({
      isOwner: false,
      queuedTurnNotApprovedHere: false,
      queuedTurnApprovedMachines: [],
    }),
  },
];

export default function ChatAdmissionSection() {
  const shown = STATES.filter((state) => showPart(state.part));
  const beforeSending = BEFORE_SENDING.filter((state) => showPart(state.part));
  return (
    <KitSection sectionKey="chat-admission">
      {beforeSending.length > 0 ? (
        <StatesGrid title="Before sending, on a personal machine" columns={1}>
          {beforeSending.map((state) => (
            <StateCell key={state.part} label={state.label} align="stretch">
              <div className="mx-auto w-full max-w-3xl">
                <SessionMachineAccessNotice
                  access={state.access}
                  shared
                  className="px-3.5 pt-2.5 md:px-4"
                  action={
                    state.access.isOwner ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="h-auto px-0 align-baseline"
                      >
                        Use another machine
                      </Button>
                    ) : (
                      <Button type="button" className="min-h-11">
                        Choose machine
                      </Button>
                    )
                  }
                />
              </div>
            </StateCell>
          ))}
        </StatesGrid>
      ) : null}
      {shown.length > 0 ? (
        <StatesGrid title="Above the composer" columns={1}>
          {shown.map((state) => (
            <StateCell key={state.part} label={state.label} align="stretch">
              <div className="mx-auto w-full max-w-3xl">
                <SessionAdmissionNotice
                  session={state.session}
                  machineAccess={state.access}
                  machines={state.machines}
                  machineAction={
                    state.picker ? (
                      <Button type="button" className="min-h-11">
                        Choose machine
                      </Button>
                    ) : undefined
                  }
                  onMoveToMachine={async () => true}
                  canControl
                  paused={false}
                  busy={false}
                  onRecheck={async () => {}}
                />
              </div>
            </StateCell>
          ))}
        </StatesGrid>
      ) : null}
    </KitSection>
  );
}
