// An embedding host's view of `SessionStartNotice`: a shared chat that runs on
// somebody else's personal machine refused this person's message. `?lang=nb`
// renders host-supplied Norwegian text; `?proxy` drops the machine reads.
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import type { MachineView, MachinesResponse, Session } from "@opengeni/sdk";
import { OpenGeniMessagesProvider, type OpenGeniMessages } from "@opengeni/react/messages";
import { SessionStartNotice } from "@opengeni/react/session-ui";
import "../src/styles.css";

const params = new URLSearchParams(window.location.search);

const norwegian: OpenGeniMessages = {
  "sessionAdmission.needsDifferentMachineTitle": "Denne meldingen trenger en annen maskin",
  "sessionAdmission.otherMachineExplanation":
    "Denne chatten kjører på {owner} sin personlige maskin «{machine}». Bare {owner} kan starte nytt arbeid der.",
  "sessionAdmission.otherMachineQueuedNext":
    "Meldingen i køen er lagret. Velg en arbeidsområde- eller skymaskin, eller spør {owner} om å dele maskinen med arbeidsområdet. Kontroller tilgang på nytt etter at du har byttet maskin for å kjøre meldingen.",
  "sessionAdmission.chooseMachine": "Velg maskin",
  "sessionAdmission.copyRequestTo": "Kopier forespørsel til {owner}",
  "sessionAdmission.recheckAccess": "Kontroller tilgang på nytt",
  "sessionAdmission.savedMessageMachineNote":
    "Bruk en arbeidsområde- eller skymaskin for den lagrede meldingen. En ny tillatelse for en personlig maskin gjelder bare nye meldinger.",
};

function machine(overrides: Partial<MachineView>): MachineView {
  return {
    enrollmentId: null,
    scope: "workspace",
    kind: "selfhosted",
    state: "online",
    active: false,
    isSessionGroup: false,
    ...overrides,
  } as MachineView;
}

function Fixture() {
  const [activeSandboxId, setActiveSandboxId] = useState("owner-laptop");
  const [rechecks, setRechecks] = useState(0);
  const active = useRef(activeSandboxId);
  active.current = activeSandboxId;
  const listing = (): MachinesResponse => {
    const current = active.current;
    const machines = [
      machine({ sandboxId: "owner-laptop", name: "Kari's MacBook Pro", scope: "user" }),
      machine({ sandboxId: "cloud", name: "box", kind: "modal", isSessionGroup: true }),
      machine({ sandboxId: "build", name: "Shared build server" }),
      machine({ sandboxId: "offline", name: "Render node", state: "offline" }),
      machine({ sandboxId: "ola", name: "Ola's laptop", scope: "user" }),
    ].map((entry) => ({ ...entry, active: entry.sandboxId === current }));
    return {
      activeSandboxId: current,
      activeEpoch: 1,
      machines,
      sessionMachineAccess:
        current === "owner-laptop"
          ? {
              sandboxId: "owner-laptop",
              machineName: "Kari's MacBook Pro",
              ownerName: "Kari",
              isOwner: false,
              queuedTurnBlocked: true,
            }
          : null,
    };
  };
  const [client] = useState(() => {
    const unused = async () => null;
    const fake: Record<string, unknown> = Object.fromEntries(
      [
        "getSession",
        "listEvents",
        "streamEvents",
        "getComposerDraft",
        "saveComposerDraft",
        "submitComposerDraft",
        "sendMessage",
        "steerMessage",
        "getQueue",
        "moveQueueItem",
        "editQueueItem",
        "steerQueueItem",
        "deleteQueueItem",
        "pauseSession",
        "sendApprovalDecision",
      ].map((method) => [method, unused]),
    );
    fake.resumeSession = async () => {
      setRechecks((count) => count + 1);
      return {};
    };
    if (!params.has("proxy")) {
      fake.listMachines = async () => listing();
      fake.swapActiveSandbox = async (
        _ws: string,
        _session: string,
        request: { target: string },
      ) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        active.current = request.target;
        setActiveSandboxId(request.target);
        return { swapped: true };
      };
    }
    return fake;
  });
  const session = {
    id: "session",
    workspaceId: "workspace",
    status: "requires_action",
    activeSandboxId,
    effectiveControl: { state: "active", controlVersion: 1, controlEtag: "etag" },
    admissionBlock: {
      reason: "database_claim_rejected",
      sqlState: "42501",
      retryPolicy: "explicit_recheck",
      blockedAt: "2026-10-21T12:40:43Z",
    },
  } as unknown as Session;
  return (
    <main className="mx-auto grid max-w-2xl gap-4 p-4 sm:p-6">
      <SessionStartNotice
        key={params.has("proxy") ? "proxy" : "full"}
        client={client as never}
        workspaceId="workspace"
        session={session}
        onSessionChanged={async () => {}}
      />
      {rechecks > 0 ? <p role="status">Rechecks sent: {rechecks}</p> : null}
    </main>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <OpenGeniMessagesProvider
    {...(params.get("lang") === "nb" ? { locale: "nb", messages: norwegian } : {})}
  >
    <Fixture />
  </OpenGeniMessagesProvider>,
);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
