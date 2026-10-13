import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ModelAccountSettingsOverview, ModelAccountPreferences } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   Sharing subscriptions, against a mocked client: the organization's rules,
   which of them workspaces can change, and a workspace's one-step return to
   the organization.
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
  personalConnectionsAllowed: true,
  personalFallbackAllowed: null,
};

let canEdit = true;
const workspaceSettings = () => ({
  workspaceId: "design",
  values: VALUES,
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
  AccountRuleLocksPage,
  OrganizationAccountRulesSection,
  WorkspaceAccountRulesSection,
  accountRuleChanges,
  changeableRulesSummary,
  ruleReach,
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

const editLocks = mock(() => undefined);
const closeLocks = mock(() => undefined);

function Organization() {
  const state = useModelAccountSettingsOverview("acme", true);
  return (
    <OrganizationAccountRulesSection
      organizationName="Acme"
      state={state}
      modelLabel={(id) => (id === "claude/opus" ? "Opus" : "Sonnet")}
      onEditLocks={editLocks}
    />
  );
}

function Locks() {
  const state = useModelAccountSettingsOverview("acme", true);
  return <AccountRuleLocksPage organizationName="Acme" state={state} onClose={closeLocks} />;
}

/** The option of the segmented control in the row labelled `row`. */
/** The switch of the setting row with this label. */
function rowSwitch(container: HTMLElement, row: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("[role='switch']")].find((candidate) =>
    (candidate.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .some((id) => document.getElementById(id)?.textContent === row),
  );
}

const checkbox = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("label")]
    .find((candidate) => candidate.textContent === label)
    ?.ownerDocument.getElementById(
      [...container.querySelectorAll("label")]
        .find((candidate) => candidate.textContent === label)!
        .getAttribute("for")!,
    ) as HTMLInputElement;

function Workspace() {
  const state = useWorkspaceModelAccountSettings("design", true);
  return (
    <WorkspaceAccountRulesSection organizationName="Acme" workspaceName="Design" state={state} />
  );
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
    // A completed save releases the writer; another rule still saves without remounting.
    const failover = rowSwitch(view.container, "Switch models when subscriptions run out")!;
    await act(async () => failover.click());
    expect(client.updateOrganizationModelAccountSettings).toHaveBeenLastCalledWith("acme", {
      crossProviderFailover: false,
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
    const sharing = rowSwitch(view.container, "Share work between Claude subscriptions");
    expect(sharing?.getAttribute("aria-checked")).toBe("true");
    await act(async () => sharing!.click());
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

test("the summary says how many rules workspaces can change", () => {
  expect(changeableRulesSummary([])).toBe("Every rule");
  expect(changeableRulesSummary(["providers", "rotation"])).toBe("4 of 5 rules");
  expect(
    changeableRulesSummary([
      "rotation",
      "personalConnectionsAllowed",
      "personalFallbackAllowed",
      "crossProviderFailover",
      "fallbackOrder",
    ]),
  ).toBe("Nothing");
});

test("a workspace's changes read as words, and locked rules are never its changes", () => {
  expect(
    accountRuleChanges({
      values: {
        ...VALUES,
        rotation: { ...VALUES.rotation, claude: { mode: "primary_first" } },
        crossProviderFailover: false,
      },
      sources: {
        ...SOURCES,
        rotation: "workspace",
        crossProviderFailover: "workspace",
        fallbackOrder: "workspace",
      },
      entrySources: {
        rotation: { claude: "workspace" },
        providers: {},
        fallbackOrder: { "claude/opus": "workspace" },
      },
    }),
  ).toEqual([
    "Claude sharing: Off",
    "Personal subscriptions: On",
    "Switch models: Off",
    "Own fallback order",
  ]);
  expect(
    accountRuleChanges({
      values: VALUES,
      sources: { ...SOURCES, personalConnectionsAllowed: "organization" },
      entrySources: { rotation: {}, providers: {}, fallbackOrder: {} },
    }),
  ).toEqual([]);
});

test("a default rule says which workspaces use it, and never guesses a count", () => {
  const workspace = (
    name: string,
    own = false,
  ): ModelAccountSettingsOverview["workspaces"][number] => ({
    workspaceId: name.toLowerCase(),
    name,
    values: own
      ? {
          ...VALUES,
          rotation: { ...VALUES.rotation, claude: { mode: "primary_first" as const } },
          crossProviderFailover: false,
        }
      : VALUES,
    sources: {
      ...SOURCES,
      personalConnectionsAllowed: "organization" as const,
      ...(own
        ? { rotation: "workspace" as const, crossProviderFailover: "workspace" as const }
        : {}),
    },
    entrySources: {
      rotation: own ? { claude: "workspace" as const } : {},
      providers: {},
      fallbackOrder: {},
    },
  });
  const all = [workspace("Design"), workspace("Platform"), workspace("Research", true)];
  expect(ruleReach(all, "personalConnectionsAllowed")).toBe("Used by every workspace");
  expect(ruleReach(all, "crossProviderFailover")).toBe(
    "Used by 2 of 3 workspaces · Research has its own (Off)",
  );
  expect(ruleReach(all, "rotation", "claude")).toBe(
    "Used by 2 of 3 workspaces · Research has its own (Off)",
  );
  expect(ruleReach(all, "rotation", "codex")).toBe("Used by every workspace");
  expect(
    ruleReach(
      [workspace("Design", true), workspace("Platform", true), workspace("Research")],
      "crossProviderFailover",
    ),
  ).toBe("Used by 1 of 3 workspaces · 2 have their own");
  // More workspaces than one page: no count.
  expect(ruleReach(null, "crossProviderFailover")).toBeNull();
});

test("dependent rules show only while their rule is on", async () => {
  client.getModelAccountSettingsOverview.mockImplementationOnce(async () => ({
    organization: {
      organizationId: "acme",
      values: { ...VALUES, personalConnectionsAllowed: false, crossProviderFailover: false },
      locked: [],
      version: 7,
      updatedAt: null,
    },
    workspaces: [],
    nextCursor: null,
  }));
  const view = await render(<Organization />);
  try {
    const text = view.container.textContent ?? "";
    expect(text).toContain("Personal subscriptions");
    expect(text).not.toContain("Fall back to personal subscriptions");
    expect(text).not.toContain("Fallback order");
    expect(text).toContain("Every rule");
  } finally {
    await view.cleanup();
  }
});

test("the organization keeps a rule the same everywhere with the version it read", async () => {
  closeLocks.mockClear();
  const view = await render(<Locks />);
  try {
    // Personal fallback is already kept the same; Design changed personal subscriptions.
    expect(checkbox(view.container, "Fall back to personal subscriptions").checked).toBe(false);
    expect(view.container.textContent).toContain("Changed in Design.");
    await act(async () => checkbox(view.container, "Personal subscriptions").click());
    expect(view.container.textContent).toContain("Design will go back to the default.");
    await act(async () => checkbox(view.container, "Personal subscriptions").click());
    await act(async () => checkbox(view.container, "Share work between subscriptions").click());
    const form = view.container.querySelector("form")!;
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(client.updateOrganizationModelAccountSettings).toHaveBeenCalledWith("acme", {
      locked: ["rotation", "personalFallbackAllowed"],
      expectedVersion: 7,
    });
    // Locking clears overrides on the server, so every workspace is read again.
    expect(client.getModelAccountSettingsOverview).toHaveBeenCalledTimes(2);
    expect(closeLocks).toHaveBeenCalled();
  } finally {
    await view.cleanup();
  }
});

test("the default rules say which workspaces use each one", async () => {
  const view = await render(<Organization />);
  try {
    const text = view.container.textContent ?? "";
    expect(text).toContain("Opus → Sonnet");
    // A kept rule, a rule every workspace uses, and one a workspace changed, with its value.
    expect(text).toContain("Used by every workspace. Workspaces can’t change it.");
    expect(text).toContain("Used by every workspace");
    expect(text).toContain("Not used by any workspace · Design has its own (Off)");
    expect(view.container.textContent).toContain("4 of 5 rules");
    const row = [...view.container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("What workspaces can change"),
    );
    await act(async () => row!.click());
    expect(editLocks).toHaveBeenCalled();
  } finally {
    await view.cleanup();
  }
});

test("a workspace admin goes back to the default in one step", async () => {
  const view = await render(<Workspace />);
  try {
    const fallback = rowSwitch(view.container, "Fall back to personal subscriptions")!;
    expect(fallback.getAttribute("aria-disabled")).toBe("true");
    const text = view.container.textContent ?? "";
    expect(text).toContain("Acme keeps this the same in every workspace.");
    expect(text).toContain("1 rule changed for Design. The rest use the defaults.");
    // Every rule says where its value comes from, with the value.
    expect(text).toContain("Uses the default (On)");
    expect(text).toContain("Changed for Design");
    const reset = buttons(view.container, "Use the default");
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
    expect(buttons(view.container, "Use the default")).toHaveLength(0);
    expect(view.container.textContent).toContain("Changed for Design");
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
    await act(async () => buttons(view.container, "Use the default")[0]!.click());
    expect(toastError).toHaveBeenCalledWith("Your organization locked this setting.");
  } finally {
    await view.cleanup();
  }
});
