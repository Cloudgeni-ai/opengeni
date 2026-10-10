import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceModelAccessPolicy, WorkspaceModelCatalogModel } from "@opengeni/sdk";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const getWorkspaceModelAccessPolicy = mock(
  async (_workspaceId: string): Promise<WorkspaceModelAccessPolicy> => ({
    allowedProviders: ["private-provider-id"],
    allowedModels: null,
  }),
);
const getWorkspaceModelCatalog = mock(async (_workspaceId: string) => ({
  models,
}));
const updateWorkspaceModelAccessPolicy = mock(
  async (
    _workspaceId: string,
    _policy: WorkspaceModelAccessPolicy,
  ): Promise<WorkspaceModelAccessPolicy> => ({
    allowedProviders: null,
    allowedModels: ["codex/gpt-5.6-sol"],
  }),
);
const updateWorkspaceSettings = mock(
  async (_workspaceId: string, _patch: { allowCreditModels?: boolean }) => ({}),
);
const context = {
  client: {
    getWorkspaceModelAccessPolicy,
    getWorkspaceModelCatalog,
    updateWorkspaceModelAccessPolicy,
    updateWorkspaceSettings,
  },
};

mock.module("@/context", () => ({
  useAppContext: () => context,
}));

mock.module("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    onConfirm: () => boolean | Promise<boolean>;
  }) =>
    open ? (
      <div data-testid="confirm-dialog">
        {title}
        <button type="button" onClick={() => void onConfirm()}>
          Confirm replacement
        </button>
      </div>
    ) : null,
}));

const {
  AllowedModelsFormPage,
  AllowedModelsRow,
  OpengeniCreditsSwitchRow,
  modelAccessPolicyDraft,
  modelAccessPolicyRequest,
  usableModelCount,
  useModelAccessPolicy,
} = await import("./model-access-policy");

/** The Defaults rows of the Models page that read the policy. */
function DefaultsRows({ canManage = true }: { canManage?: boolean }) {
  const state = useModelAccessPolicy("workspace-a");
  return (
    <>
      <AllowedModelsRow state={state} onEdit={() => undefined} />
      <OpengeniCreditsSwitchRow state={state} canManage={canManage} />
    </>
  );
}

function ModelAccessPolicySection(props: { workspaceId: string; canManage: boolean }) {
  return <AllowedModelsFormPage {...props} onClose={() => undefined} />;
}

function model(
  id: string,
  provider: string,
  providerLabel: string,
  policyAllowed = true,
  cost?: WorkspaceModelCatalogModel["cost"],
): WorkspaceModelCatalogModel {
  return {
    id,
    label: id,
    provider,
    providerLabel,
    ...(cost ? { cost } : {}),
    api: "responses",
    credentialReadiness: {
      status: "ready",
      reason: null,
      basis: "connection",
      checkedAt: null,
    },
    policyAllowed,
    availability: {
      status: "unknown",
      selectable: true,
      reason: null,
      checkedAt: null,
    },
  };
}

const models = [
  model("codex/gpt-5.6-sol", "codex", "Codex"),
  model("supergrok/grok-4.6", "supergrok", "SuperGrok"),
  model("managed/model", "opengeni", "Opengeni"),
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/** A model's checkbox; Radix switches add a hidden one of their own inside a form. */
const MODEL_BOX = 'input[type="checkbox"]:not([aria-hidden="true"])';

function everyModelSwitch(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('button[role="switch"]');
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  getWorkspaceModelAccessPolicy.mockClear();
  getWorkspaceModelCatalog.mockClear();
  updateWorkspaceModelAccessPolicy.mockClear();
  updateWorkspaceSettings.mockClear();
  updateWorkspaceSettings.mockImplementation(async () => ({}));
  getWorkspaceModelAccessPolicy.mockImplementation(async (_workspaceId: string) => ({
    allowedProviders: ["private-provider-id"],
    allowedModels: null,
  }));
  getWorkspaceModelCatalog.mockImplementation(async (_workspaceId: string) => ({
    models,
  }));
  updateWorkspaceModelAccessPolicy.mockImplementation(
    async (_workspaceId: string, _policy: WorkspaceModelAccessPolicy) => ({
      allowedProviders: null,
      allowedModels: ["codex/gpt-5.6-sol"],
    }),
  );
});

describe("workspace model access policy editor", () => {
  test("turning Allow every model off lists models to pick, and Save shows once something changed", async () => {
    getWorkspaceModelAccessPolicy.mockImplementation(async () => ({
      allowedProviders: null,
      allowedModels: null,
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<ModelAccessPolicySection workspaceId="workspace-a" canManage />);
        await flush();
      });
      const footer = () => container.querySelector("footer")!;
      expect(footer().closest("[data-slot=form-frame]")?.className).toContain(
        "[&>form>footer]:hidden",
      );
      expect(container.querySelector(MODEL_BOX)).toBeNull();
      await act(async () => everyModelSwitch(container)!.click());
      const boxes = [...container.querySelectorAll<HTMLInputElement>(MODEL_BOX)];
      expect(boxes).toHaveLength(3);
      expect(boxes.every((box) => box.checked)).toBe(true);
      expect(container.textContent).toContain("Codex");
      expect(footer().closest("[data-slot=form-frame]")?.className ?? "").not.toContain(
        "[&>form>footer]:hidden",
      );
      // Add a model by ID is a quiet button that reveals one field.
      expect(container.querySelector("#allowed-models-add")).toBeNull();
      const addById = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "Add a model by ID",
      );
      await act(async () => addById?.click());
      expect(container.querySelector("#allowed-models-add")).not.toBeNull();
      expect(updateWorkspaceModelAccessPolicy).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("projects unrestricted policy to every visible model", () => {
    const draft = modelAccessPolicyDraft({ allowedProviders: null, allowedModels: null }, models);
    expect(draft.mode).toBe("unrestricted");
    expect([...draft.selectedModelIds]).toEqual(models.map((candidate) => candidate.id));
    expect(modelAccessPolicyRequest(draft)).toEqual({
      allowedProviders: null,
      allowedModels: null,
    });
  });

  test("keeps provider allowlists opaque until an explicit exact-model replacement", () => {
    const draft = modelAccessPolicyDraft(
      { allowedProviders: ["codex-subscription"], allowedModels: null },
      [
        models[0]!,
        { ...models[1]!, policyAllowed: false },
        { ...models[2]!, policyAllowed: false },
      ],
    );
    expect(draft.mode).toBe("provider");
    expect([...draft.selectedModelIds]).toEqual(["codex/gpt-5.6-sol"]);
    expect(modelAccessPolicyRequest(draft)).toEqual({
      allowedProviders: ["codex-subscription"],
      allowedModels: null,
    });

    draft.mode = "selected";
    draft.selectedModelIds.add("supergrok/grok-4.6");
    expect(modelAccessPolicyRequest(draft)).toEqual({
      allowedProviders: null,
      allowedModels: ["codex/gpt-5.6-sol", "supergrok/grok-4.6"],
    });
  });

  test("preserves provider policy when a rolling API upgrade omits policy verdicts", async () => {
    const legacyModels = models.map(({ policyAllowed: _policyAllowed, ...candidate }) => candidate);
    const policy = {
      allowedProviders: ["private-provider-id"],
      allowedModels: null,
    };
    const draft = modelAccessPolicyDraft(policy, legacyModels);

    expect(draft.mode).toBe("provider");
    expect(draft.policyVerdictComplete).toBe(false);
    expect(modelAccessPolicyRequest(draft)).toEqual(policy);

    getWorkspaceModelCatalog.mockImplementation(async () => ({
      models: legacyModels,
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<ModelAccessPolicySection workspaceId="workspace-a" canManage />);
        await flush();
      });

      expect(container.textContent).toContain("Refresh after the update finishes");
      expect(container.textContent).not.toContain("Choose exact models");
      expect(container.textContent).not.toContain("private-provider-id");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("preserves future exact model IDs and empty lists remain a total block", () => {
    const draft = modelAccessPolicyDraft(
      { allowedProviders: null, allowedModels: ["future/model-v2"] },
      models,
    );
    expect([...draft.selectedModelIds]).toEqual(["future/model-v2"]);
    expect(modelAccessPolicyRequest(draft)).toEqual({
      allowedProviders: null,
      allowedModels: ["future/model-v2"],
    });

    draft.selectedModelIds.clear();
    expect(modelAccessPolicyRequest(draft)).toEqual({
      allowedProviders: null,
      allowedModels: [],
    });
  });

  test("keeps provider identities private and confirms before exact-model conversion", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<ModelAccessPolicySection workspaceId="workspace-a" canManage />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container.textContent).toContain("Limited to whole providers");
      expect(container.textContent).not.toContain("private-provider-id");

      const chooseExact = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Choose exact models"),
      );
      expect(chooseExact).toBeDefined();
      await act(async () => chooseExact?.click());
      expect(container.textContent).toContain("Replace the provider limit?");
      expect(container.querySelector('[role="radiogroup"]')).toBeNull();

      const confirm = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Confirm replacement"),
      );
      await act(async () => confirm?.click());
      expect(container.textContent).toContain("This replaces the provider limit");
      expect(everyModelSwitch(container)?.getAttribute("aria-checked")).toBe("false");
      // Models show by name; the ID only in the tooltip.
      expect(container.querySelector('[title="codex/gpt-5.6-sol"]')).not.toBeNull();
      expect(container.textContent).not.toContain("private-provider-id");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("ignores a completed save after navigation to another workspace", async () => {
    const workspaceA = "workspace-a";
    const workspaceB = "workspace-b";
    const pendingSave = deferred<WorkspaceModelAccessPolicy>();
    getWorkspaceModelAccessPolicy.mockImplementation(async (workspaceId: string) =>
      workspaceId === workspaceA
        ? { allowedProviders: ["private-provider-id"], allowedModels: null }
        : { allowedProviders: null, allowedModels: null },
    );
    updateWorkspaceModelAccessPolicy.mockImplementation(
      async (workspaceId: string, _policy: WorkspaceModelAccessPolicy) =>
        workspaceId === workspaceA
          ? await pendingSave.promise
          : { allowedProviders: null, allowedModels: null },
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <ModelAccessPolicySection key={workspaceA} workspaceId={workspaceA} canManage />,
        );
        await flush();
      });

      const chooseExact = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Choose exact models"),
      );
      await act(async () => chooseExact?.click());
      const confirm = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Confirm replacement"),
      );
      await act(async () => confirm?.click());
      const save = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save",
      );
      expect(save?.disabled).toBe(false);
      await act(async () => save?.click());
      expect(updateWorkspaceModelAccessPolicy).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(
          <ModelAccessPolicySection key={workspaceB} workspaceId={workspaceB} canManage />,
        );
        await flush();
      });
      expect(everyModelSwitch(container)?.getAttribute("aria-checked")).toBe("true");
      expect(container.textContent).not.toContain("Limited to whole providers");

      await act(async () => {
        pendingSave.resolve({
          allowedProviders: null,
          allowedModels: ["codex/gpt-5.6-sol"],
        });
        await pendingSave.promise;
        await flush();
      });

      expect(everyModelSwitch(container)?.getAttribute("aria-checked")).toBe("true");
      expect(container.textContent).not.toContain("Limited to whole providers");
      expect(
        getWorkspaceModelAccessPolicy.mock.calls.filter(([workspaceId]) =>
          Object.is(workspaceId, workspaceA),
        ),
      ).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("Use Opengeni credits", () => {
  const creditCatalog = [
    model("codex/gpt-5.6-sol", "codex", "Codex", true, "subscription"),
    model("gpt-6-sol", "openai", "Opengeni", true, "credits"),
    model("gpt-6-luna", "openai", "Opengeni", true, "credits"),
    model("opper/aws/claude-opus-5-5", "opper", "Opper", true, "credits"),
  ];

  async function render(node: ReactNode) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(node);
      await flush();
    });
    return {
      container,
      async cleanup() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  /** The Defaults rows hold one switch: Use Opengeni credits. */
  function creditSwitch(container: HTMLElement) {
    return container.querySelector<HTMLButtonElement>('button[role="switch"]');
  }

  test("one switch turns every credit model off and leaves the allowlists alone", async () => {
    let allowCreditModels = true;
    getWorkspaceModelAccessPolicy.mockImplementation(async () => ({
      allowedProviders: null,
      allowedModels: ["codex/gpt-5.6-sol", "gpt-6-sol"],
      allowCreditModels,
    }));
    getWorkspaceModelCatalog.mockImplementation(async () => ({ models: creditCatalog }));
    updateWorkspaceSettings.mockImplementation(async (_workspaceId, patch) => {
      allowCreditModels = patch.allowCreditModels ?? allowCreditModels;
      return {};
    });
    const view = await render(<DefaultsRows />);
    try {
      expect(view.container.textContent).toContain("Use Opengeni credits");
      const toggle = creditSwitch(view.container)!;
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      // Codex is still allowed, so nothing to confirm: it saves at once.
      await act(async () => {
        toggle.click();
        await flush();
      });
      expect(view.container.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
      // The switch is a workspace setting; the allowlist is never rewritten.
      expect(updateWorkspaceSettings).toHaveBeenCalledTimes(1);
      expect(updateWorkspaceSettings.mock.calls[0]).toEqual([
        "workspace-a",
        { allowCreditModels: false },
      ]);
      expect(updateWorkspaceModelAccessPolicy).not.toHaveBeenCalled();
      expect(creditSwitch(view.container)!.getAttribute("aria-checked")).toBe("false");
      // The listed credit model no longer counts toward the allowlist summary.
      expect(view.container.textContent).toContain("1 model");
    } finally {
      await view.cleanup();
    }
  });

  test("asks first when turning credits off would leave no model new work can run on", async () => {
    getWorkspaceModelAccessPolicy.mockImplementation(async () => ({
      allowedProviders: null,
      allowedModels: ["gpt-6-sol", "gpt-6-luna"],
      allowCreditModels: true,
    }));
    getWorkspaceModelCatalog.mockImplementation(async () => ({ models: creditCatalog }));
    const view = await render(<DefaultsRows />);
    try {
      await act(async () => {
        creditSwitch(view.container)!.click();
        await flush();
      });
      expect(view.container.textContent).toContain("Turn off Opengeni credits?");
      expect(updateWorkspaceSettings).not.toHaveBeenCalled();
      const confirm = [...view.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Confirm replacement"),
      );
      getWorkspaceModelAccessPolicy.mockImplementation(async () => ({
        allowedProviders: null,
        allowedModels: ["gpt-6-sol", "gpt-6-luna"],
        allowCreditModels: false,
      }));
      await act(async () => {
        confirm!.click();
        await flush();
      });
      expect(updateWorkspaceSettings.mock.calls[0]![1]).toEqual({ allowCreditModels: false });
      expect(updateWorkspaceModelAccessPolicy).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain(
        "Opengeni credits are off and no other model can run, so new work can't start.",
      );
    } finally {
      await view.cleanup();
    }
  });

  test("hidden when no model here is paid with credits, shown again whenever it is off", async () => {
    getWorkspaceModelAccessPolicy.mockImplementation(async () => ({
      allowedProviders: null,
      allowedModels: null,
    }));
    getWorkspaceModelCatalog.mockImplementation(async () => ({
      models: [model("codex/gpt-5.6-sol", "codex", "Codex", true, "subscription")],
    }));
    let view = await render(<DefaultsRows />);
    try {
      expect(view.container.textContent).not.toContain("Use Opengeni credits");
    } finally {
      await view.cleanup();
    }
    getWorkspaceModelAccessPolicy.mockImplementation(async () => ({
      allowedProviders: null,
      allowedModels: null,
      allowCreditModels: false,
    }));
    view = await render(<DefaultsRows />);
    try {
      expect(view.container.textContent).toContain("Use Opengeni credits");
      expect(view.container.textContent).toContain("All except credits");
    } finally {
      await view.cleanup();
    }
  });

  test("hidden on a server that doesn't report the switch, so nothing is saved it can't enforce", async () => {
    getWorkspaceModelAccessPolicy.mockImplementation(async () => ({
      allowedProviders: null,
      allowedModels: null,
    }));
    getWorkspaceModelCatalog.mockImplementation(async () => ({ models: creditCatalog }));
    const view = await render(<DefaultsRows />);
    try {
      expect(view.container.textContent).toContain("All models");
      expect(view.container.textContent).not.toContain("Use Opengeni credits");
      expect(updateWorkspaceSettings).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });

  test("the organization's provider list can't be turned into an exact list from a workspace with credits off", async () => {
    // The hosting workspace has credits off, so its catalog verdicts block credit models.
    getWorkspaceModelAccessPolicy.mockImplementation(async () => ({
      allowedProviders: null,
      allowedModels: null,
      allowCreditModels: false,
    }));
    getWorkspaceModelCatalog.mockImplementation(async () => ({
      models: creditCatalog.map((candidate) => ({
        ...candidate,
        policyAllowed: candidate.cost !== "credits",
      })),
    }));
    const organizationDefaults = {
      defaults: { allowedProviders: ["private-provider-id"], allowedModels: null },
      loading: false,
      error: null,
      reload: async () => undefined,
      update: async () => {
        throw new Error("unexpected save");
      },
    } as never;
    const view = await render(
      <AllowedModelsFormPage
        workspaceId="workspace-a"
        canManage
        onClose={() => undefined}
        organizationDefaults={organizationDefaults}
      />,
    );
    try {
      expect(view.container.textContent).toContain("Limited to whole providers");
      expect(view.container.textContent).toContain("Allow all instead");
      expect(view.container.textContent).not.toContain("Choose exact models");
      expect(view.container.textContent).toContain("Opengeni credits are off in this workspace");
    } finally {
      await view.cleanup();
    }
  });

  test("Allowed models mutes credit models while credits are off and never sends the switch", async () => {
    getWorkspaceModelAccessPolicy.mockImplementation(async () => ({
      allowedProviders: null,
      allowedModels: null,
      allowCreditModels: false,
    }));
    getWorkspaceModelCatalog.mockImplementation(async () => ({ models: creditCatalog }));
    const view = await render(<ModelAccessPolicySection workspaceId="workspace-a" canManage />);
    try {
      expect(view.container.textContent).toContain("Opengeni credits are off");
      await act(async () => everyModelSwitch(view.container)!.click());
      const box = (label: string) =>
        view.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      expect(box("gpt-6-sol").disabled).toBe(true);
      expect(box("codex/gpt-5.6-sol").disabled).toBe(false);
      expect(view.container.textContent).toContain("Credits off");
      // No group checkbox when credits lock every model in the group.
      expect(view.container.querySelector('input[aria-label="All Opengeni models"]')).toBeNull();
      // Unchecking the only usable model warns that nothing can run.
      await act(async () => box("codex/gpt-5.6-sol").click());
      expect(view.container.textContent).toContain("No model can run here");
      const save = [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save",
      );
      await act(async () => {
        save!.click();
        await flush();
      });
      const request = updateWorkspaceModelAccessPolicy.mock.calls[0]![1];
      expect(request).not.toHaveProperty("allowCreditModels");
      expect(request.allowedModels).toEqual(
        ["gpt-6-luna", "gpt-6-sol", "opper/aws/claude-opus-5-5"].sort(),
      );
    } finally {
      await view.cleanup();
    }
  });

  test("a group checkbox picks or clears every model of that provider at once", async () => {
    getWorkspaceModelAccessPolicy.mockImplementation(async () => ({
      allowedProviders: null,
      allowedModels: ["gpt-6-sol"],
      allowCreditModels: true,
    }));
    getWorkspaceModelCatalog.mockImplementation(async () => ({ models: creditCatalog }));
    const view = await render(<ModelAccessPolicySection workspaceId="workspace-a" canManage />);
    try {
      const group = () =>
        view.container.querySelector<HTMLInputElement>('input[aria-label="All Opengeni models"]')!;
      const box = (label: string) =>
        view.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      expect(group().indeterminate).toBe(true);
      await act(async () => group().click());
      expect(box("gpt-6-sol").checked).toBe(true);
      expect(box("gpt-6-luna").checked).toBe(true);
      expect(group().checked).toBe(true);
      await act(async () => group().click());
      expect(box("gpt-6-sol").checked).toBe(false);
      expect(box("gpt-6-luna").checked).toBe(false);
      // Other groups are untouched; the group shows who pays.
      expect(box("codex/gpt-5.6-sol").checked).toBe(false);
      expect(view.container.textContent).toContain("Opengeni · Opengeni credits");
    } finally {
      await view.cleanup();
    }
  });

  test("counts only ready, allowed models that credits don't block", () => {
    const draft = modelAccessPolicyDraft(
      { allowedProviders: null, allowedModels: null, allowCreditModels: false },
      creditCatalog,
    );
    expect(draft.allowCreditModels).toBe(false);
    expect(usableModelCount(creditCatalog, draft, false)).toBe(1);
    expect(usableModelCount(creditCatalog, draft, true)).toBe(4);
    expect(
      usableModelCount(
        creditCatalog.map((candidate) =>
          candidate.cost === "subscription"
            ? {
                ...candidate,
                credentialReadiness: { ...candidate.credentialReadiness, status: "not_ready" },
              }
            : candidate,
        ),
        draft,
        false,
      ),
    ).toBe(0);
  });
});
