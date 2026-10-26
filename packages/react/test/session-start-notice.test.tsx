import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MachineView, MachinesResponse, Session } from "@opengeni/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OpenGeniMessagesProvider, createOpenGeniText, englishMessages } from "../src/messages";
import {
  personalMachineCopy,
  savedMessageMachineChoices,
  sessionAdmissionNeedsDifferentMachine,
  sessionAdmissionReason,
} from "../src/session";
import { SessionStartNotice } from "../src/session-ui";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
});

const control = {
  state: "active",
  controlVersion: 4,
  controlEtag: "etag-4",
} as unknown as Session["effectiveControl"];

function blockedSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-a",
    workspaceId: "workspace-a",
    status: "requires_action",
    activeSandboxId: "owner-laptop",
    effectiveControl: control,
    admissionBlock: {
      reason: "database_claim_rejected",
      sqlState: "42501",
      retryPolicy: "explicit_recheck",
      blockedAt: "2026-10-21T12:40:43Z",
    },
    ...overrides,
  } as unknown as Session;
}

function machine(overrides: Partial<MachineView>): MachineView {
  return {
    sandboxId: "machine",
    enrollmentId: "enrollment",
    scope: "workspace",
    name: "Machine",
    kind: "selfhosted",
    state: "online",
    active: false,
    isSessionGroup: false,
    ...overrides,
  } as unknown as MachineView;
}

const fleet: MachineView[] = [
  machine({ sandboxId: "owner-laptop", name: "Kari's laptop", scope: "user", active: true }),
  machine({ sandboxId: "cloud", name: "box", kind: "modal", isSessionGroup: true }),
  machine({ sandboxId: "build", name: "Build server" }),
  machine({ sandboxId: "offline", name: "Offline server", state: "offline" }),
  machine({ sandboxId: "someone-else", name: "Ola's laptop", scope: "user" }),
];

function fakeClient(response: MachinesResponse | null) {
  const sessionMethods = [
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
  ];
  const client: Record<string, unknown> = Object.fromEntries(
    sessionMethods.map((method) => [method, mock(async () => null)]),
  );
  const resumeSession = mock(async () => ({}));
  client.resumeSession = resumeSession;
  const swapActiveSandbox = mock(async () => ({ swapped: true }));
  const listMachines = mock(async () => response!);
  if (response) {
    client.listMachines = listMachines;
    client.swapActiveSandbox = swapActiveSandbox;
  }
  return { client, resumeSession, swapActiveSandbox, listMachines };
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  // Let the machine read settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container!.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
}

const blockedResponse: MachinesResponse = {
  activeSandboxId: "owner-laptop",
  activeEpoch: 3,
  machines: fleet,
  sessionMachineAccess: {
    sandboxId: "owner-laptop",
    machineName: "Kari's laptop",
    ownerName: "Kari",
    isOwner: false,
    queuedTurnBlocked: true,
  },
};

describe("session start model", () => {
  test("only reachable shared machines and the chat's own cloud machine can take a saved message", () => {
    expect(savedMessageMachineChoices(fleet).map((choice) => choice.sandboxId)).toEqual([
      "cloud",
      "build",
    ]);
  });

  test("a machine-owner refusal needs the refusal, the permission check and the live projection", () => {
    const reason = sessionAdmissionReason(blockedSession());
    const access = blockedResponse.sessionMachineAccess!;
    expect(sessionAdmissionNeedsDifferentMachine(reason, access)).toBe(true);
    expect(
      sessionAdmissionNeedsDifferentMachine(reason, { ...access, queuedTurnBlocked: false }),
    ).toBe(false);
    expect(
      sessionAdmissionNeedsDifferentMachine(
        sessionAdmissionReason(blockedSession({ status: "running" } as Partial<Session>)),
        access,
      ),
    ).toBe(false);
  });

  test("copy comes from the host catalog and names the owner and machine", () => {
    const t = createOpenGeniText({
      locale: "nb",
      messages: {
        "sessionAdmission.otherMachineExplanation":
          "Denne chatten kjører på {owner} sin personlige maskin «{machine}».",
      },
    });
    const copy = personalMachineCopy(t, blockedResponse.sessionMachineAccess!, { queued: true });
    expect(copy.explanation).toBe(
      "Denne chatten kjører på Kari sin personlige maskin «Kari's laptop».",
    );
    expect(copy.next).toBe(
      englishMessages["sessionAdmission.otherMachineQueuedNext"].replaceAll("{owner}", "Kari"),
    );
    expect(
      personalMachineCopy(
        t,
        { ...blockedResponse.sessionMachineAccess!, isOwner: true },
        { queued: true },
      ).ownerRequest,
    ).toBeNull();
  });
});

describe("SessionStartNotice", () => {
  test("explains a refused shared-chat message in the host's language and offers allowed machines", async () => {
    const { client, resumeSession, swapActiveSandbox } = fakeClient(blockedResponse);
    const onSessionChanged = mock(async () => {});
    await render(
      <OpenGeniMessagesProvider
        locale="nb"
        messages={{
          "sessionAdmission.needsDifferentMachineTitle": "Denne meldingen trenger en annen maskin",
          "sessionAdmission.chooseMachine": "Velg maskin",
        }}
      >
        <SessionStartNotice
          client={client as never}
          workspaceId="workspace-a"
          session={blockedSession()}
          onSessionChanged={onSessionChanged}
        />
      </OpenGeniMessagesProvider>,
    );
    expect(container!.textContent).toContain("Denne meldingen trenger en annen maskin");
    expect(container!.textContent).toContain("Only Kari can start new work there.");
    expect(container!.textContent).toContain("The queued message is saved.");
    // Rechecking on the same machine would be refused again.
    expect(button("Recheck access")!.disabled).toBe(true);

    await act(async () => button("Velg maskin")!.click());
    const labels = [...container!.querySelectorAll("li button")].map(
      (choice) => choice.textContent,
    );
    expect(labels).toEqual(["Cloud sandbox", "Build server"]);

    await act(async () => button("Build server")!.click());
    expect(swapActiveSandbox).toHaveBeenCalledTimes(1);
    expect(swapActiveSandbox.mock.calls[0]).toEqual([
      "workspace-a",
      "session-a",
      { target: "build" },
    ] as never);
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
    // Moving never resends the saved message.
    expect(resumeSession).not.toHaveBeenCalled();
  });

  test("after the move, one fenced recheck runs the saved message", async () => {
    const moved: MachinesResponse = {
      activeSandboxId: "build",
      activeEpoch: 4,
      machines: fleet.map((entry) => ({ ...entry, active: entry.sandboxId === "build" })),
      sessionMachineAccess: null,
    };
    const { client, resumeSession } = fakeClient(moved);
    const onSessionChanged = mock(async () => {});
    await render(
      <SessionStartNotice
        client={client as never}
        workspaceId="workspace-a"
        session={blockedSession({ activeSandboxId: "build" } as Partial<Session>)}
        onSessionChanged={onSessionChanged}
      />,
    );
    expect(container!.textContent).toContain("Permission needed");
    const recheck = button("Recheck access")!;
    await act(async () => {
      recheck.click();
      recheck.click();
    });
    expect(resumeSession).toHaveBeenCalledTimes(1);
    const [workspaceId, sessionId, options] = resumeSession.mock.calls[0] as unknown as [
      string,
      string,
      { expectedControlEtag: string; clientEventId: string },
    ];
    expect([workspaceId, sessionId, options.expectedControlEtag]).toEqual([
      "workspace-a",
      "session-a",
      "etag-4",
    ]);
    expect(options.clientEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
  });

  test("warns before sending on somebody else's personal machine, and stays quiet for its owner", async () => {
    const idle = blockedSession({ status: "idle", admissionBlock: null } as Partial<Session>);
    const preSend = {
      ...blockedResponse,
      sessionMachineAccess: { ...blockedResponse.sessionMachineAccess!, queuedTurnBlocked: false },
    };
    const other = fakeClient(preSend);
    await render(
      <SessionStartNotice
        client={other.client as never}
        workspaceId="workspace-a"
        session={idle}
        onSessionChanged={async () => {}}
      />,
    );
    expect(container!.textContent).toContain("Choose a machine before sending");
    expect(container!.textContent).toContain("Your draft stays here.");
    await act(async () => root!.unmount());
    container!.remove();

    const owner = fakeClient({
      ...preSend,
      sessionMachineAccess: { ...preSend.sessionMachineAccess, isOwner: true },
    });
    await render(
      <SessionStartNotice
        client={owner.client as never}
        workspaceId="workspace-a"
        session={idle}
        onSessionChanged={async () => {}}
      />,
    );
    expect(container!.textContent).toBe("");
  });

  test("a host proxy without machine reads still explains the block, without choices", async () => {
    const { client } = fakeClient(null);
    await render(
      <SessionStartNotice
        client={client as never}
        workspaceId="workspace-a"
        session={blockedSession()}
        onSessionChanged={async () => {}}
      />,
    );
    expect(container!.textContent).toContain("Permission needed");
    expect(button("Choose machine")).toBeUndefined();
    expect(button("Recheck access")!.disabled).toBe(false);
  });

  test("a viewer who can't read machines never requests them", async () => {
    const { client, listMachines } = fakeClient(blockedResponse);
    await render(
      <SessionStartNotice
        client={client as never}
        workspaceId="workspace-a"
        session={blockedSession()}
        onSessionChanged={async () => {}}
        machinesEnabled={false}
      />,
    );
    expect(listMachines).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("Permission needed");
    expect(button("Choose machine")).toBeUndefined();
  });
});
