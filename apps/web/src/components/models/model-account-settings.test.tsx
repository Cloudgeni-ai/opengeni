import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/* ----------------------------------------------------------------------------
   Account rules against a mocked client: the organization's locks, every
   workspace's sources, and a workspace's one-step return to the organization.
   -------------------------------------------------------------------------- */

const VALUES = {
  rotation: { codex: { mode: "spread" as const } },
  providers: {},
  crossProviderFailover: true,
  fallbackOrder: { "claude/opus": ["claude/sonnet"] },
  personalConnectionsAllowed: true,
  personalFallbackAllowed: false,
};
const SOURCES = {
  rotation: "organization",
  providers: "organization",
  crossProviderFailover: "organization",
  fallbackOrder: "organization",
  personalConnectionsAllowed: "workspace",
  personalFallbackAllowed: "locked",
} as const;
const OVERRIDES = {
  rotation: null,
  providers: null,
  crossProviderFailover: null,
  fallbackOrder: null,
  personalConnectionsAllowed: false,
  personalFallbackAllowed: null,
};

let canEdit = true;
const workspaceSettings = () => ({
  workspaceId: "design",
  values: { ...VALUES, personalConnectionsAllowed: false },
  sources: SOURCES,
  entrySources: { rotation: {}, providers: {}, fallbackOrder: {} },
  locked: ["personalFallbackAllowed"],
  overrides: OVERRIDES,
  version: 3,
  updatedAt: null,
  canEdit,
});
const client = {
  getModelAccountSettingsOverview: mock(async () => ({
    organization: {
      organizationId: "acme",
      values: VALUES,
      locked: ["personalFallbackAllowed"],
      version: 7,
      updatedAt: null,
    },
    workspaces: [
      {
        workspaceId: "design",
        name: "Design",
        values: { ...VALUES, personalConnectionsAllowed: false },
        sources: SOURCES,
        entrySources: { rotation: {}, providers: {}, fallbackOrder: {} },
      },
    ],
    nextCursor: null,
  })),
  updateOrganizationModelAccountSettings: mock(async () => ({})),
  getWorkspaceModelAccountSettings: mock(async () => workspaceSettings()),
  updateWorkspaceModelAccountSettings: mock(async () => workspaceSettings()),
};
const toastError = mock((_message: string) => undefined);

mock.module("@/context", () => ({ useAppContext: () => ({ client }) }));
mock.module("sonner", () => ({ toast: { error: toastError, success: mock(() => undefined) } }));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const {
  AccountRulesOverviewSection,
  OrganizationAccountRulesSection,
  WorkspaceAccountRulesSection,
  rotationSummary,
  useModelAccountSettingsOverview,
  useWorkspaceModelAccountSettings,
} = await import("./model-account-settings");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  canEdit = true;
  for (const fn of Object.values(client)) fn.mockClear();
  toastError.mockClear();
});

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const buttons = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].filter(
    (candidate) => candidate.textContent?.trim() === text,
  );

function Organization() {
  const state = useModelAccountSettingsOverview("acme", true);
  return (
    <>
      <OrganizationAccountRulesSection
        organizationName="Acme"
        state={state}
        modelLabel={(id) => (id === "claude/opus" ? "Opus" : "Sonnet")}
      />
      <AccountRulesOverviewSection
        organizationName="Acme"
        state={state}
        onOpenWorkspace={() => {}}
      />
    </>
  );
}

function Workspace() {
  const state = useWorkspaceModelAccountSettings("design", true);
  return <WorkspaceAccountRulesSection organizationName="Acme" state={state} />;
}

test("rotation summary reads the modes across providers", () => {
  expect(rotationSummary({})).toBe("Spread work");
  expect(rotationSummary({ codex: { mode: "primary_first" } })).toBe("Primary only");
  expect(rotationSummary({ codex: { mode: "spread" }, claude: { mode: "primary_first" } })).toBe(
    "Mixed",
  );
});

test("the organization locks a rule with the version it read", async () => {
  const view = await render(<Organization />);
  try {
    expect(view.container.textContent).toContain("Opus → Sonnet");
    expect(buttons(view.container, "Locked · Unlock")).toHaveLength(1);
    // Rotation is the first rule; lock it.
    await act(async () => buttons(view.container, "Lock for every workspace")[0]!.click());
    expect(client.updateOrganizationModelAccountSettings).toHaveBeenCalledWith("acme", {
      locked: ["personalFallbackAllowed", "rotation"],
      expectedVersion: 7,
    });
    // Locking clears overrides on the server, so every workspace is read again.
    expect(client.getModelAccountSettingsOverview).toHaveBeenCalledTimes(2);
  } finally {
    await view.cleanup();
  }
});

test("the overview names each rule's source", async () => {
  const view = await render(<Organization />);
  try {
    const row = view.container.querySelector("ul[aria-label='Account rules by workspace'] li");
    expect(row?.textContent).toContain("Design");
    expect(row?.textContent).toContain(", set by this workspace");
    expect(row?.textContent).toContain(", locked by Acme");
  } finally {
    await view.cleanup();
  }
});

test("a workspace admin goes back to the organization's value in one step", async () => {
  const view = await render(<Workspace />);
  try {
    const fallback = view.container.querySelectorAll("[role='switch']")[1]!;
    expect(fallback.getAttribute("aria-disabled")).toBe("true");
    expect(view.container.textContent).toContain("Locked by Acme.");
    const reset = buttons(view.container, "Use Acme’s setting");
    expect(reset).toHaveLength(1);
    await act(async () => reset[0]!.click());
    expect(client.updateWorkspaceModelAccountSettings).toHaveBeenCalledWith("design", {
      personalConnectionsAllowed: null,
      expectedVersion: 3,
    });
  } finally {
    await view.cleanup();
  }
});

test("a member sees the sources without changing them", async () => {
  canEdit = false;
  const view = await render(<Workspace />);
  try {
    expect(buttons(view.container, "Use Acme’s setting")).toHaveLength(0);
    expect(view.container.textContent).toContain("Set for this workspace.");
    for (const control of view.container.querySelectorAll("[role='switch']")) {
      expect(control.getAttribute("aria-disabled")).toBe("true");
    }
  } finally {
    await view.cleanup();
  }
});

test("a refused change says why", async () => {
  client.updateWorkspaceModelAccountSettings.mockImplementationOnce(async () => {
    throw Object.assign(new Error("conflict"), { details: { reason: "setting_locked" } });
  });
  const view = await render(<Workspace />);
  try {
    await act(async () => buttons(view.container, "Use Acme’s setting")[0]!.click());
    expect(toastError).toHaveBeenCalledWith("Your organization locked this setting.");
  } finally {
    await view.cleanup();
  }
});
