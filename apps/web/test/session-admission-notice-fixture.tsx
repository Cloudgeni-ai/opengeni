import { createRoot } from "react-dom/client";
import type { Session } from "@opengeni/sdk";
import { SessionAdmissionNotice } from "../src/components/session/session-admission-notice";
import { SessionMachineAccessNotice } from "../src/components/session/session-machine-access-notice";
import { useState } from "react";
import {
  SessionMachinePickerAction,
  type SessionRunsOn,
} from "../src/components/session/sandbox-switcher";
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
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
