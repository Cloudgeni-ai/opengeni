import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { RepositoryContextPickerProps } from "@/components/repository-picker";
import { registerDom } from "../../../packages/react/test/render-hook";

registerDom();

const workspaceId = "7c1f4c1e-2f0a-4a7b-9d55-0b6f7f1d2e3a";
const setupStarts: string[] = [];

// Setup never finishes, so the dialog stays in its "Preparing connection…"
// state; only the menu and dialog layering is under test here.
const transport = {
  pending: (id: string) => {
    setupStarts.push(id);
    return new Promise<never>(() => {});
  },
};
const context = {
  client: { connectTransport: () => transport },
  refreshGitHub: async () => {},
};

mock.module("@/context", () => ({ useAppContext: () => context }));

const { useGitHubAppConnectLauncher } = await import("@/components/github-app-connect-launcher");
const { RepositoryContextPicker } = await import("@/components/repository-picker");

const pickerProps: Omit<RepositoryContextPickerProps, "onConnectWorkspaceApp"> = {
  setupMode: "platform",
  configured: true,
  status: "unbound",
  // Only gates whether this principal may connect; it is never followed.
  installUrl: `https://api.opengeni.test/v1/workspaces/${workspaceId}/github/connect?state=minted-at-load`,
  linkUrl: null,
  installations: [],
  repositories: [],
  groups: [],
  selectedRepoIds: new Set<number>(),
  selectedRepoRefs: {},
  selectedInstallationId: null,
  manualRepos: [],
  manualOpen: false,
  githubAppOpen: false,
  org: "",
  pending: false,
  repoBusy: false,
  githubAppBusy: false,
  onRefresh: async () => {},
  onToggleRepo: () => {},
  onRefChange: () => {},
  onManualOpenChange: () => {},
  onManualAdd: () => {},
  onManualUpdate: () => {},
  onManualRemove: () => {},
  onGitHubAppOpenChange: () => {},
  onOrgChange: () => {},
  onStartGitHubApp: () => {},
  onConfigureInstallation: async () => {},
  onDisconnectInstallation: async () => {},
} as unknown as Omit<RepositoryContextPickerProps, "onConnectWorkspaceApp">;

/** The route shape: the launcher's dialog is hosted beside the menu, not in it. */
function PickerWithLauncher() {
  const launcher = useGitHubAppConnectLauncher(workspaceId);
  return createElement(
    Fragment,
    null,
    launcher.element,
    createElement(RepositoryContextPicker, {
      ...pickerProps,
      onConnectWorkspaceApp: launcher.open,
    } as RepositoryContextPickerProps),
  );
}

let mounted: { root: Root; host: HTMLElement } | null = null;

afterEach(async () => {
  if (!mounted) return;
  const { root, host } = mounted;
  mounted = null;
  await act(async () => root.unmount());
  host.remove();
  setupStarts.length = 0;
});

async function render(): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(PickerWithLauncher)));
  mounted = { root, host };
}

async function settle(): Promise<void> {
  // The dialog module is lazy; let its import and Radix's layer effects land.
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const menu = () => document.querySelector('[role="menu"]');
const dialog = () => document.querySelector('[role="dialog"]');

async function openMenuAndConnect(): Promise<void> {
  await act(async () => {
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Repository context"]')!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  expect(menu()).toBeTruthy();
  // The modal menu disables pointer events outside itself while open.
  expect(document.body.style.pointerEvents).toBe("none");
  // No link in the menu carries a signed state captured when the page loaded.
  expect(
    [...menu()!.querySelectorAll("a")].filter((anchor) =>
      anchor.getAttribute("href")?.includes("state="),
    ),
  ).toEqual([]);
  const connect = [...menu()!.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Connect workspace App",
  );
  expect(connect).toBeTruthy();
  await act(async () => connect!.click());
  await settle();
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await settle();
}

describe("repository picker Connect workspace App", () => {
  test("opens the Connect dialog outside the menu, which closes when the popup takes focus", async () => {
    await render();
    await openMenuAndConnect();

    expect(dialog()).toBeTruthy();
    expect(dialog()!.textContent).toContain("Connect GitHub App");
    expect(dialog()!.textContent).toContain("Preparing connection…");
    // The dialog is not rendered inside the menu, so closing the menu cannot
    // unmount setup.
    expect(menu()?.contains(dialog()!) ?? false).toBe(false);
    // Setup started from the click, for this workspace.
    expect(setupStarts).toEqual([workspaceId]);

    // GitHub's authorization popup takes focus: the menu closes, setup stays.
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await settle();
    expect(menu()).toBeNull();
    expect(dialog()).toBeTruthy();
    expect(dialog()!.textContent).toContain("Connect GitHub App");

    // Closing the dialog leaves the page interactive again.
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.body.style.pointerEvents).toBe("");
  });

  test("cancelling the dialog first returns to the menu, then the page is interactive", async () => {
    await render();
    await openMenuAndConnect();
    expect(dialog()).toBeTruthy();

    // Escape closes only the top layer: the dialog, not the menu behind it.
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(menu()).toBeTruthy();

    await pressEscape();
    expect(menu()).toBeNull();
    expect(document.body.style.pointerEvents).toBe("");
  });
});

describe("repository picker routes host the Connect dialog", () => {
  const read = (path: string) => Bun.file(`${import.meta.dir}/${path}`).text();

  test("the new-session picker opens the launcher it renders outside the menu", async () => {
    const source = await read("routes/sessions-index.tsx");
    expect(source).toContain("const githubAppConnect = useGitHubAppConnectLauncher(workspaceId);");
    expect(source).toContain("{githubAppConnect.element}");
    expect(source).toContain("onConnectWorkspaceApp={githubAppConnect.open}");
  });

  test("the follow-up picker opens the session's route-level Connect dialog", async () => {
    const source = await read("routes/session.tsx");
    // The route already hosts a Connect dialog outside every menu for reconnects.
    expect(source).toContain(
      "() => setReconnectRequest(githubAppConnectRequest(workspaceId, reconnectTransport))",
    );
    expect(source).toContain("onConnectGitHubApp={connectGitHubApp}");
    expect(source).toContain("useFollowUpRepositories(props.session, props.onConnectGitHubApp)");
    expect(source).toContain('if (reconnectRequest.providerId === "github-app") {');
  });
});
