import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ModelAccountSettingsOverview, ModelAccountPreferences } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   Account rules against a mocked client: the organization's locks, every
   workspace's sources, and a workspace's one-step return to the organization.
   -------------------------------------------------------------------------- */

const VALUES = {
  rotation: {
    codex: { mode: "spread" as const },
    claude: { mode: "spread" as const },
    xai: { mode: "spread" as const },
  },
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
  getModelAccountSettingsOverview: mock(
    async (_id: string, _page?: { after?: string }): Promise<ModelAccountSettingsOverview> => ({
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
    }),
  ),
  updateOrganizationModelAccountSettings: mock(async () => ({})),
  getWorkspaceModelAccountSettings: mock(async () => workspaceSettings()),
  updateWorkspaceModelAccountSettings: mock(async () => workspaceSettings()),
  getModelAccountPreferences: mock(
    async (_id: string): Promise<ModelAccountPreferences> => ({
      personalFallbackOptIn: false,
      version: 2,
    }),
  ),
  updateModelAccountPreferences: mock(
    async (
      _id: string,
      request: { personalFallbackOptIn: boolean; expectedVersion?: number },
    ): Promise<ModelAccountPreferences> => ({
      personalFallbackOptIn: request.personalFallbackOptIn,
      version: 3,
    }),
  ),
};
const toastError = mock((_message: string) => undefined);

mock.module("@/context", () => ({
  useAppContext: () => ({ client, authSession: { user: { id: "owner" } } }),
}));
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
const { PersonalFallbackPreference } = await import("./model-account-policy-controls");

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
    rerender: async (next: ReactNode) => {
      await act(async () => root.render(next));
    },
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

test("fallback mappings save exact order and support an explicit empty override", async () => {
  const view = await render(<Organization />);
  try {
    await act(async () => buttons(view.container, "Edit order")[0]!.click());
    await act(async () =>
      (
        view.container.querySelector('button[aria-label="Remove Sonnet"]') as HTMLButtonElement
      ).click(),
    );
    await act(async () => buttons(view.container, "Save order")[0]!.click());
    expect(client.updateOrganizationModelAccountSettings).toHaveBeenCalledWith("acme", {
      fallbackOrder: { "claude/opus": [] },
      expectedVersion: 7,
    });
    // A completed save releases the writer; locking still works without remounting.
    await act(async () => buttons(view.container, "Lock for every workspace").at(-1)!.click());
    expect(client.updateOrganizationModelAccountSettings).toHaveBeenLastCalledWith("acme", {
      locked: ["personalFallbackAllowed", "fallbackOrder"],
      expectedVersion: 7,
    });
  } finally {
    await view.cleanup();
  }
});

test("workspace fallback reset inherits only the selected model mapping", async () => {
  const view = await render(<Workspace />);
  try {
    await act(async () => buttons(view.container, "Edit order")[0]!.click());
    await act(async () => buttons(view.container, "Use organization order")[0]!.click());
    expect(client.updateWorkspaceModelAccountSettings).toHaveBeenCalledWith("design", {
      fallbackOrder: { "claude/opus": null },
      expectedVersion: 3,
    });
  } finally {
    await view.cleanup();
  }
});

test("overview loads subsequent pages once and deduplicates workspace identities", async () => {
  const first = await client.getModelAccountSettingsOverview("acme");
  client.getModelAccountSettingsOverview.mockResolvedValueOnce({ ...first, nextCursor: "next" });
  const view = await render(<Organization />);
  try {
    client.getModelAccountSettingsOverview.mockResolvedValueOnce({
      ...first,
      workspaces: [
        first.workspaces[0]!,
        { ...first.workspaces[0]!, workspaceId: "research", name: "Research" },
      ],
      nextCursor: null,
    });
    await act(async () => buttons(view.container, "Show more workspaces")[0]!.click());
    expect(client.getModelAccountSettingsOverview).toHaveBeenLastCalledWith("acme", {
      after: "next",
    });
    expect(
      view.container.querySelectorAll('ul[aria-label="Account rules by workspace"] li'),
    ).toHaveLength(2);
    expect(buttons(view.container, "Show more workspaces")).toHaveLength(0);
  } finally {
    await view.cleanup();
  }
});

test("late overview pages cannot replace another organization's rules", async () => {
  const first = await client.getModelAccountSettingsOverview("acme");
  client.getModelAccountSettingsOverview.mockResolvedValueOnce({ ...first, nextCursor: "next" });
  function Page({ id }: { id: string }) {
    const state = useModelAccountSettingsOverview(id, true);
    return (
      <AccountRulesOverviewSection state={state} organizationName={id} onOpenWorkspace={() => {}} />
    );
  }
  const view = await render(<Page id="acme" />);
  try {
    let settle!: (value: ModelAccountSettingsOverview) => void;
    client.getModelAccountSettingsOverview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    await act(async () => buttons(view.container, "Show more workspaces")[0]!.click());
    client.getModelAccountSettingsOverview.mockResolvedValueOnce({
      ...first,
      workspaces: [],
      nextCursor: null,
    });
    await view.rerender(<Page id="other" />);
    await act(async () => settle({ ...first, nextCursor: null }));
    expect(view.container.textContent).not.toContain("Design");
  } finally {
    await view.cleanup();
  }
});

test("personal fallback permission does not opt a person in", async () => {
  const view = await render(<PersonalFallbackPreference organizationId="acme" allowed />);
  try {
    const control = view.container.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(client.updateModelAccountPreferences).not.toHaveBeenCalled();
    await act(async () => control.click());
    expect(client.updateModelAccountPreferences).toHaveBeenCalledWith("acme", {
      personalFallbackOptIn: true,
      expectedVersion: 2,
    });
  } finally {
    await view.cleanup();
  }
});

test("a late personal preference save cannot overwrite the newly selected organization", async () => {
  const view = await render(<PersonalFallbackPreference organizationId="acme" allowed />);
  try {
    let settle!: (value: ModelAccountPreferences) => void;
    client.updateModelAccountPreferences.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    await act(async () =>
      (view.container.querySelector('[role="switch"]') as HTMLButtonElement).click(),
    );
    await view.rerender(<PersonalFallbackPreference organizationId="other" allowed />);
    await act(async () => settle({ personalFallbackOptIn: true, version: 3 }));
    expect(view.container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe(
      "false",
    );
  } finally {
    await view.cleanup();
  }
});

test("rotation saves the selected provider without guessing another provider's policy", async () => {
  const view = await render(<Organization />);
  try {
    const select = view.container.querySelector(
      'select[aria-label="Claude account rotation"]',
    ) as HTMLSelectElement;
    await act(async () => {
      select.value = "primary_first";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(client.updateOrganizationModelAccountSettings).toHaveBeenCalledWith("acme", {
      rotation: { claude: { mode: "primary_first" } },
      expectedVersion: 7,
    });
  } finally {
    await view.cleanup();
  }
});

test("personal fallback is read-only when the effective organization rule refuses it", async () => {
  const view = await render(<PersonalFallbackPreference organizationId="acme" allowed={false} />);
  try {
    const control = view.container.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(control.getAttribute("aria-disabled")).toBe("true");
    await act(async () => control.click());
    expect(client.updateModelAccountPreferences).not.toHaveBeenCalled();
  } finally {
    await view.cleanup();
  }
});

test("a person can withdraw a saved fallback opt-in even while its use is disallowed", async () => {
  client.getModelAccountPreferences.mockResolvedValueOnce({
    personalFallbackOptIn: true,
    version: 2,
  });
  const view = await render(<PersonalFallbackPreference organizationId="acme" allowed={false} />);
  try {
    await act(async () =>
      (view.container.querySelector('[role="switch"]') as HTMLButtonElement).click(),
    );
    expect(client.updateModelAccountPreferences).toHaveBeenCalledWith("acme", {
      personalFallbackOptIn: false,
      expectedVersion: 2,
    });
  } finally {
    await view.cleanup();
  }
});

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
