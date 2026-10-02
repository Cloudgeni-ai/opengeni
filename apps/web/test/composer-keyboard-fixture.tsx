import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ChatComposer, OpenGeniProvider } from "@opengeni/react";
import type { MachineView } from "@opengeni/react/machines";
import type { OpenGeniClient } from "@opengeni/sdk";
import { ComposerMobilePlus } from "../src/components/composer-mobile-plus";
import { RunsOnMenuBody, runsOnSummary } from "../src/components/session/new-session-settings-menu";
import {
  SessionRunsOnMenuBody,
  type SessionRunsOn,
} from "../src/components/session/sandbox-switcher";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { idleComposer } from "../src/dev/composer-chrome-fixtures";
import { emptySessionDraft } from "../src/lib/session-create";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const existing = params.get("chat") === "existing";
const dialog = params.get("presentation") === "dialog";
const theme = params.get("theme") ?? "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;
const evidence = { attachments: [] as string[], drafts: [] as unknown[], sends: 0 };
Object.assign(window, { composerKeyboard: evidence });
const client = {} as OpenGeniClient;
const baseMachines = [
  {
    sandboxId: "cloud",
    kind: "modal",
    isSessionGroup: true,
    name: "Cloud sandbox",
    state: "online",
  },
  {
    sandboxId: "offline",
    kind: "selfhosted",
    name: "Offline machine",
    state: "offline",
    os: "linux",
    arch: "x86_64",
  },
  {
    sandboxId: "build",
    kind: "selfhosted",
    name: "Build machine",
    state: "online",
    os: "linux",
    arch: "x86_64",
  },
  {
    sandboxId: "headless",
    kind: "selfhosted",
    name: "Headless machine",
    state: "display_unavailable",
    os: "linux",
    arch: "x86_64",
  },
] as MachineView[];

function Fixture() {
  const [activeId, setActiveId] = useState("cloud");
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState({
    ...emptySessionDraft(),
    compute: { kind: "machine", sandboxId: "build", folder: { kind: "root" } },
  } as ReturnType<typeof emptySessionDraft>);
  const choices = {
    draft,
    machines: baseMachines.slice(1),
    rigs: [],
    workspaceDefaultRigId: null,
    selfhostedPrimary: false,
    fleetLoadFailed: false,
    selectedChannelId: null,
    selectionHistory: { projects: [] },
  };
  const machines = baseMachines.map((machine) => ({
    ...machine,
    active: machine.sandboxId === activeId,
  }));
  const activeMachine = machines.find((machine) => machine.active)!;
  const runsOn: SessionRunsOn = {
    machines,
    activeMachine,
    activeName: activeMachine.name,
    sandboxBackend: "modal",
    hasChoices: true,
    fleet: {
      canAttach: true,
      attaching: false,
      attachingSandboxId: null,
      attach: async (id: string) => {
        evidence.attachments.push(id);
        setActiveId(id);
      },
    } as SessionRunsOn["fleet"],
  };
  const changeDraft = (next: ReturnType<typeof emptySessionDraft>) => {
    evidence.drafts.push(next);
    setDraft(next);
  };
  return (
    <OpenGeniProvider client={client} workspaceId="keyboard-preview">
      <TooltipProvider>
        <main data-canvas className="flex min-h-dvh flex-col bg-bg text-fg">
          <header className="border-b border-border px-6 py-4">
            <h1 className="text-xl font-semibold">{existing ? "Existing chat" : "New chat"}</h1>
            <p className="mt-1 text-xs text-fg-muted">
              Keyboard preview · Sample machines and local-only selection
            </p>
          </header>
          <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-end gap-6 p-6">
            <p className="text-sm text-fg-muted">
              {existing
                ? "Change where this chat runs under + > Runs on."
                : "Choose the connected machine and its working folder under + > Runs on."}
            </p>
            <ChatComposer
              responsiveBasis="container"
              composer={idleComposer({
                value: message,
                setValue: setMessage,
                canSend: message.length > 0,
                hasDraftContent: () => message.length > 0,
                send: async () => {
                  evidence.sends++;
                  return true;
                },
              })}
              placeholder={existing ? "Send a follow-up…" : "Message the agent…"}
              attachButtonClassName="hidden"
              controlsLeading={
                <ComposerMobilePlus
                  fileUploadsEnabled={false}
                  servers={[]}
                  firstPartyTools={[]}
                  selection={{ mcpServerIds: new Set(), firstPartyToolIds: new Set() }}
                  onToolSelectionChange={() => {}}
                  expandedPanelPresentation={dialog ? "dialog" : "menu"}
                  menuSide="top"
                  runsOn={{
                    summary: existing ? runsOn.activeName : runsOnSummary(choices),
                    panel: existing ? (
                      <SessionRunsOnMenuBody
                        runsOn={runsOn}
                        workspaceId="keyboard-preview"
                        rigId={null}
                      />
                    ) : (
                      <RunsOnMenuBody
                        {...choices}
                        disabled={false}
                        onChange={changeDraft}
                        onComputeChange={changeDraft}
                        onRetryMachines={() => {}}
                      />
                    ),
                  }}
                />
              }
            />
          </section>
        </main>
      </TooltipProvider>
    </OpenGeniProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
