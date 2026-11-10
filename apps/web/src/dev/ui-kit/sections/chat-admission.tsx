import type { MachineView, ChatSession as Session, SessionMachineAccess } from "@opengeni/sdk";
import { SessionAdmissionNotice, SessionMachineAccessNotice } from "@opengeni/react/session-ui";
import { Button } from "@opengeni/react/ui/button";
import { FailedSessionBanner } from "@opengeni/react/app/components/session/failed-session-banner";

import { useEffect, useState } from "react";

import { KitSection, StateCell, StatesGrid } from "../kit";
import { showPart } from "./chat-shared";

/* ----------------------------------------------------------------------------
   A saved message that can't start: the notice above the composer that says
   why and offers the one way forward. The real notice renders against fixture
   sessions and machine projections; moving and allowing resolve at once. Most
   blocks start the saved message by themselves once fixed, so they show no
   button; only an unknown failure offers Try again.
   -------------------------------------------------------------------------- */

function blocked(reason: string, activeSandboxId = "laptop", sqlState = "OG002"): Session {
  return {
    id: "session-kit",
    workspaceId: "ws-kit",
    status: "requires_action",
    activeSandboxId,
    effectiveControl: { state: "active", controlVersion: 4, controlEtag: "etag-kit" },
    admissionBlock: {
      reason,
      sqlState,
      retryPolicy: "explicit_recheck",
      blockedAt: "2026-10-28T11:52:00Z",
    },
  } as unknown as Session;
}

/** The same chat, paused by someone. */
function paused(session: Session): Session {
  return {
    ...session,
    effectiveControl: { state: "paused", controlVersion: 5, controlEtag: "etag-kit-paused" },
  } as unknown as Session;
}

/** The same chat, shared with the workspace. */
function shared(session: Session): Session {
  return {
    ...session,
    tenancy: { ...session.tenancy, visibility: "workspace" },
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
  allow?: boolean;
  paused?: boolean;
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
    label: "Another resource isn't allowed",
    session: blocked("personal_resource_grant_required", "cloud"),
    access: null,
  },
  {
    part: "machine-access-owner-queued",
    label: "Your machine isn't allowed for this chat (you can allow it)",
    session: blocked("personal_resource_grant_required"),
    access: access({ queuedTurnNotApprovedHere: false, queuedTurnApprovedMachines: [] }),
    allow: true,
  },
  {
    part: "machine-access-owner-paused",
    label: "Your machine isn't allowed, and the chat is paused",
    session: paused(blocked("personal_resource_grant_required")),
    access: access({ queuedTurnNotApprovedHere: false, queuedTurnApprovedMachines: [] }),
    allow: true,
    paused: true,
  },
  {
    part: "machine-access-owner-shared",
    label: "Your machine isn't allowed, in a chat shared with the workspace",
    session: shared(blocked("personal_resource_grant_required")),
    access: access({ queuedTurnNotApprovedHere: false, queuedTurnApprovedMachines: [] }),
    allow: true,
  },
  {
    part: "machine-access-owner-shared-paused",
    label: "Your machine isn't allowed, in a paused shared chat",
    session: paused(shared(blocked("personal_resource_grant_required"))),
    access: access({ queuedTurnNotApprovedHere: false, queuedTurnApprovedMachines: [] }),
    allow: true,
    paused: true,
  },
  {
    part: "machine-access-legacy",
    label: "Your machine refused at claim (permission check)",
    session: blocked("database_claim_rejected", "laptop", "42501"),
    access: access({ queuedTurnNotApprovedHere: false, queuedTurnApprovedMachines: [] }),
    allow: true,
  },
  {
    part: "machine-access-member-queued",
    label: "The owner's machine isn't allowed, seen by another member",
    session: blocked("personal_resource_grant_required"),
    access: access({
      isOwner: false,
      queuedTurnNotApprovedHere: false,
      queuedTurnApprovedMachines: [],
    }),
  },
  {
    part: "needs-different-machine",
    label: "Your message, on someone else's machine",
    session: blocked("database_claim_rejected", "laptop", "42501"),
    access: access({
      isOwner: false,
      queuedTurnBlocked: true,
      queuedTurnNotApprovedHere: false,
      queuedTurnApprovedMachines: [],
    }),
    picker: true,
  },
  {
    part: "membership",
    label: "The sender lost workspace access",
    session: blocked("initiator_membership_required", "cloud", "OG001"),
    access: null,
  },
  {
    part: "permission",
    label: "Another permission check",
    session: blocked("database_claim_rejected", "cloud", "42501"),
    access: null,
  },
  {
    part: "unknown",
    label: "Something else went wrong (Try again)",
    session: blocked("database_claim_rejected", "cloud", "23505"),
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

/* A turn the database refused because the chat's machine isn't allowed for it. */
const MACHINE_ACCESS_FAILURE = {
  reason: "Machine access needed: this chat isn’t allowed to use “Laptop” right now.",
  failureCode: "machine_access_required",
  failedAt: "2026-10-28T11:52:00Z",
  consecutiveRecoveryCount: null,
};
const MACHINE_ACCESS_FAILED: { part: string; label: string; owner: boolean }[] = [
  { part: "machine-access-owner", label: "Your machine, not allowed here", owner: true },
  { part: "machine-access-member", label: "Someone else's machine", owner: false },
];

/** After a refusal, the chat moved to another machine: the notice sees the move happen. */
function MachineChangedState() {
  const [moved, setMoved] = useState(false);
  useEffect(() => setMoved(true), []);
  const session = blocked(
    "personal_resource_grant_required",
    moved ? "workspace-machine" : "laptop",
  );
  return (
    <SessionAdmissionNotice
      session={session}
      machineAccess={moved ? null : access({ isOwner: false, queuedTurnBlocked: true })}
      canControl
      paused={false}
      busy={false}
      onRecheck={async () => {}}
    />
  );
}

export default function ChatAdmissionSection() {
  const shown = STATES.filter((state) => showPart(state.part));
  const beforeSending = BEFORE_SENDING.filter((state) => showPart(state.part));
  const machineAccessFailed = MACHINE_ACCESS_FAILED.filter((state) => showPart(state.part));
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
                  paused={state.paused === true}
                  busy={false}
                  onRecheck={async () => {}}
                  onAllowMachine={state.allow ? async () => {} : undefined}
                />
              </div>
            </StateCell>
          ))}
        </StatesGrid>
      ) : null}
      {showPart("machine-changed") ? (
        <StatesGrid title="After the chat moved" columns={1}>
          <StateCell label="Moved to a machine it can use" align="stretch">
            <div className="mx-auto w-full max-w-3xl">
              <MachineChangedState />
            </div>
          </StateCell>
        </StatesGrid>
      ) : null}
      {machineAccessFailed.length > 0 ? (
        <StatesGrid title="A turn the machine wasn't allowed for" columns={1}>
          {machineAccessFailed.map((state) => (
            <StateCell key={state.part} label={state.label} align="stretch">
              <FailedSessionBanner
                failure={MACHINE_ACCESS_FAILURE}
                actions={{ onRetry: async () => true, retryBlocker: null }}
                allowMachine={
                  state.owner ? { machineName: "Laptop", onAllow: async () => null } : undefined
                }
              />
            </StateCell>
          ))}
        </StatesGrid>
      ) : null}
    </KitSection>
  );
}
