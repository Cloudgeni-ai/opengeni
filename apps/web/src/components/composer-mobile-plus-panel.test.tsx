import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ComposerMobilePlusPanel, PANEL_DIALOG_TITLE } =
  await import("./composer-mobile-plus-panel");
const { RunsOnMenuBody, VisibilityMenuBody } =
  await import("@/components/session/new-session-settings-menu");
const { Dialog } = await import("@/components/ui/dialog");
const { DropdownMenu } = await import("@/components/ui/dropdown-menu");
const { emptySessionDraft } = await import("@/lib/session-create");

afterAll(() => GlobalRegistrator.unregister());
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

type PanelProps = ComponentProps<typeof ComposerMobilePlusPanel>;

function panelProps(panel: PanelProps["panel"], dialogOpen: boolean): PanelProps {
  return {
    triggerRef: { current: null },
    panel,
    setPanel: () => {},
    setOpen: () => {},
    dialogOpen,
    dialogFocusOwnerRef: { current: dialogOpen },
    fileUploadsEnabled: false,
    servers: [],
    firstPartyTools: [],
    selection: { mcpServerIds: new Set(), firstPartyToolIds: new Set() },
    onToolSelectionChange: () => {},
    runsOn: {
      summary: "Managed sandbox",
      panel: (
        <RunsOnMenuBody
          draft={emptySessionDraft()}
          machines={[
            {
              sandboxId: "sandbox-build-01",
              name: "build-01",
              state: "online",
              os: "linux",
              arch: "x86_64",
            } as never,
          ]}
          rigs={[]}
          workspaceDefaultRigId={null}
          selfhostedPrimary={false}
          fleetLoadFailed={false}
          selectedChannelId={null}
          selectionHistory={{ projects: [] }}
          disabled={false}
          onChange={() => {}}
          onComputeChange={() => {}}
          onRetryMachines={() => {}}
        />
      ),
    },
    visibility: {
      summary: "Workspace",
      panel: <VisibilityMenuBody value="workspace" disabled={false} onChange={() => {}} />,
    },
  };
}

async function render(props: PanelProps) {
  await act(async () =>
    root.render(
      <Dialog open={props.dialogOpen}>
        <DropdownMenu open={!props.dialogOpen}>
          <ComposerMobilePlusPanel {...props} />
        </DropdownMenu>
      </Dialog>,
    ),
  );
}

function dialogName(): string | null {
  const dialog = document.querySelector('[role="dialog"]');
  const labelledBy = dialog?.getAttribute("aria-labelledby");
  return labelledBy ? (document.getElementById(labelledBy)?.textContent ?? null) : null;
}

test("every drill-in dialog is named for its own panel", () => {
  expect(PANEL_DIALOG_TITLE["runs-on"]).toBe("Runs on");
  expect(PANEL_DIALOG_TITLE.visibility).toBe("Who can see this chat");
  expect(PANEL_DIALOG_TITLE.settings).toBe("Chat settings");
  expect(PANEL_DIALOG_TITLE.voice).toBe("Voice model");
  expect(new Set(Object.values(PANEL_DIALOG_TITLE)).size).toBe(
    Object.keys(PANEL_DIALOG_TITLE).length,
  );
});

test("Runs on as a dialog is named Runs on and uses Tab-reachable radios", async () => {
  await render(panelProps("runs-on", true));
  expect(dialogName()).toBe("Runs on");
  const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  expect(radios.map((radio) => radio.textContent)).toEqual([
    expect.stringContaining("Managed sandbox"),
    expect.stringContaining("build-01"),
  ]);
  expect(radios.every((radio) => radio.tabIndex === 0)).toBe(true);
  expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
});

test("an existing chat's Chat settings opens its Agent tab instead of a second editor", async () => {
  const opened: string[] = [];
  const panels: string[] = [];
  const openStates: boolean[] = [];
  await render({
    ...panelProps("root", false),
    setPanel: (panel) => panels.push(panel),
    setOpen: (open) => openStates.push(open),
    chatSettings: {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      scope: "workspace",
      canEdit: true,
      onOpen: () => opened.push("agent-tab"),
    },
  });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    row.textContent?.includes("Chat settings"),
  );
  if (!item) throw new Error("Missing Chat settings");
  expect(item.textContent).toContain("Agent tab");
  await act(async () => item.click());
  expect(opened).toEqual(["agent-tab"]);
  expect(openStates).toEqual([false]);
  expect(panels).not.toContain("settings");
});

test("a new chat's Chat settings still drills into its draft Agent learning", async () => {
  const panels: string[] = [];
  await render({
    ...panelProps("root", false),
    setPanel: (panel) => panels.push(panel),
    draftChatSettings: {
      workspaceId: "workspace-1",
      scope: "workspace",
      value: {},
      onChange: () => {},
    },
  });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    row.textContent?.includes("Chat settings"),
  );
  if (!item) throw new Error("Missing Chat settings");
  await act(async () => item.click());
  expect(panels).toEqual(["settings"]);
});

test("Runs on and Visibility inside the + menu use menu radios", async () => {
  await render(panelProps("runs-on", false));
  expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);
  expect(document.querySelectorAll('[role="radio"]')).toHaveLength(0);

  await render(panelProps("visibility", false));
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);
});
