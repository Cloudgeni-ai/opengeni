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
const context = {
  client: {
    getWorkspaceModelAccessPolicy,
    getWorkspaceModelCatalog,
    updateWorkspaceModelAccessPolicy,
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

const { ModelAccessPolicySection, modelAccessPolicyDraft, modelAccessPolicyRequest } =
  await import("./model-access-policy");

function model(
  id: string,
  provider: string,
  providerLabel: string,
  policyAllowed = true,
): WorkspaceModelCatalogModel {
  return {
    id,
    label: id,
    provider,
    providerLabel,
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
  model("managed/model", "opengeni", "OpenGeni"),
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

      expect(container.textContent).toContain("Refresh after the control plane update");
      expect(container.textContent).toContain("Provider policy replacement unavailable");
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

  test("collapses the editor by default", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<ModelAccessPolicySection workspaceId="workspace-a" canManage />);
        await flush();
      });

      expect(container.querySelector("details")?.open).toBe(false);
      expect(container.textContent).toContain("3 of 3");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
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

      expect(container.textContent).toContain("Provider-level restriction active");
      expect(container.textContent).not.toContain("private-provider-id");

      const chooseExact = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Choose exact models"),
      );
      expect(chooseExact).toBeDefined();
      await act(async () => chooseExact?.click());
      expect(container.textContent).toContain("Replace the provider-level model policy?");
      expect(container.textContent).not.toContain("Selected models");

      const confirm = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Confirm replacement"),
      );
      await act(async () => confirm?.click());
      expect(container.textContent).toContain("Provider-level restriction will be replaced");
      expect(container.textContent).toContain("Selected models");
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
      expect(container.textContent).toContain("All models");
      expect(container.textContent).not.toContain("Provider-level restriction active");

      await act(async () => {
        pendingSave.resolve({
          allowedProviders: null,
          allowedModels: ["codex/gpt-5.6-sol"],
        });
        await pendingSave.promise;
        await flush();
      });

      expect(container.textContent).toContain("All models");
      expect(container.textContent).not.toContain("Provider-level restriction active");
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
