import { createRoot } from "react-dom/client";
import type { Session } from "@opengeni/sdk";
import { SessionAdmissionNotice } from "@opengeni/react/app/components/session/session-admission-notice";
import { SessionMachineAccessNotice } from "@opengeni/react/app/components/session/session-machine-access-notice";
import { useState } from "react";
import {
  SessionMachinePickerAction,
  type SessionRunsOn,
} from "@opengeni/react/app/components/session/sandbox-switcher";
import "../src/styles.css";

const reasons = [
  "database_claim_rejected",
  "initiator_membership_required",
  "personal_resource_grant_required",
  "future_reason",
];

function Fixture() {
  const [moved, setMoved] = useState(false);
  const machines = [
    {
      sandboxId: "workspace",
      name: "Workspace build machine",
      scope: "workspace",
      kind: "selfhosted",
      state: "online",
      active: false,
      isSessionGroup: false,
    },
    {
      sandboxId: "personal",
      name: "My laptop",
      scope: "user",
      kind: "selfhosted",
      state: "online",
      active: false,
      isSessionGroup: false,
    },
  ];
  const runsOn = {
    machines,
    activeMachine: null,
    activeName: "Design workstation",
    hasChoices: true,
    sandboxBackend: "selfhosted",
    fleet: { canAttach: true, attaching: false, attachingSandboxId: null, mutationError: null },
  } as SessionRunsOn;
  const action = (queuedWork = false) => (
    <SessionMachinePickerAction
      runsOn={runsOn}
      workspaceId="preview"
      rigId={null}
      queuedWork={queuedWork}
      move={async () => {
        setMoved(true);
        return null;
      }}
    />
  );
  return (
    <main className="mx-auto grid max-w-3xl gap-4 p-6">
      <h1>Session admission checks</h1>
      <SessionMachineAccessNotice
        access={{
          sandboxId: "machine",
          machineName: "Design workstation",
          ownerName: "Alex",
          isOwner: false,
          queuedTurnBlocked: false,
        }}
        action={action()}
      />
      <SessionAdmissionNotice
        session={
          {
            status: "requires_action",
            activeSandboxId: moved ? "workspace" : "machine",
            admissionBlock: { reason: "database_claim_rejected", sqlState: "42501" },
          } as Session
        }
        canControl
        paused={false}
        busy={false}
        onRecheck={async () => {}}
        machineAccess={
          moved
            ? null
            : {
                sandboxId: "machine",
                machineName: "Design workstation",
                ownerName: "Alex",
                isOwner: false,
                queuedTurnBlocked: true,
              }
        }
        machineAction={action(true)}
      />
      {reasons.map((reason) => (
        <SessionAdmissionNotice
          key={reason}
          session={
            {
              status: "requires_action",
              admissionBlock: { reason, sqlState: "42501" },
            } as unknown as Session
          }
          canControl
          paused={false}
          busy={false}
          refreshRequired={new URLSearchParams(window.location.search).has("refresh")}
          onRecheck={async () => {
            throw new Error("private server detail");
          }}
        />
      ))}
      {moved ? (
        <p role="status">Machine changed. Recheck access to run the saved message.</p>
      ) : null}
    </main>
  );
}
/** `?view=waiting`: other people's updates waiting on a personal machine, as each person sees it. */
function WaitingWorkFixture() {
  const [continued, setContinued] = useState(false);
  const blocked = {
    status: continued ? "running" : "requires_action",
    activeSandboxId: "machine",
    admissionBlock: { reason: "database_claim_rejected", sqlState: "42501" },
    effectiveControl: { state: "active", controlVersion: 1, controlEtag: "1" },
  } as unknown as Session;
  const access = (isOwner: boolean, isYou: boolean) => ({
    sandboxId: "machine",
    machineName: "Maya’s MacBook Pro",
    ownerName: "Maya Chen",
    isOwner,
    queuedTurnBlocked: false,
    waitingWork: continued ? [] : [{ name: "Sam Rivera", isYou, results: 4 }],
  });
  const fail = new URLSearchParams(window.location.search).has("fail");
  return (
    <main className="mx-auto grid max-w-3xl gap-6 p-4 sm:p-6">
      <section className="grid gap-2" aria-label="Machine owner">
        <h2 className="text-sm text-fg-muted">The machine’s owner</h2>
        <SessionAdmissionNotice
          session={blocked}
          canControl
          paused={false}
          busy={false}
          onRecheck={async () => {}}
          machineAccess={access(true, false)}
          onContinueWaitingWork={async () => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            if (fail) throw Object.assign(new Error("conflict"), { status: 409 });
            setContinued(true);
          }}
        />
        {continued ? <p role="status">The agent is reading them now.</p> : null}
      </section>
      <section className="grid gap-2" aria-label="Member whose updates wait">
        <h2 className="text-sm text-fg-muted">The member whose agents sent them</h2>
        <SessionAdmissionNotice
          session={blocked}
          canControl
          paused={false}
          busy={false}
          onRecheck={async () => {}}
          machineAccess={access(false, true)}
        />
        <SessionMachineAccessNotice access={access(false, true)} />
      </section>
      <section className="grid gap-2" aria-label="Someone else">
        <h2 className="text-sm text-fg-muted">Someone else in the chat</h2>
        <SessionAdmissionNotice
          session={blocked}
          canControl
          paused={false}
          busy={false}
          onRecheck={async () => {}}
          machineAccess={access(false, false)}
        />
      </section>
    </main>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  new URLSearchParams(window.location.search).get("view") === "waiting" ? (
    <WaitingWorkFixture />
  ) : (
    <Fixture />
  ),
);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
