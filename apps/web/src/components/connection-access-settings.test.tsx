import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError, OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

mock.module("sonner", () => ({
  toast: { success: mock(() => undefined), error: mock(() => undefined) },
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { ConnectionAccessFormPage, ConnectionAccessRows, useConnectionAccess, workspacesShort } =
  await import("./connection-access-settings");
const { modelsScopeLabels, organizationReachLabel } = await import("./models/models-ui");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

for (const kind of ["codex", "supergrok", "vercel_gateway", "openrouter", "opper"] as const) {
  test(`${kind} workspace access stays editable before restrictions and after resetting to all models`, async () => {
    let policy = {
      allowedModels: null as string[] | null,
      allowedWorkspaces: null as string[] | null,
      allowPersonalWorkspaces: true,
      version: 1,
    };
    const writes: (typeof policy)[] = [];
    const client = Object.assign(new OpenGeniBrowserClient({ baseUrl: "http://localhost" }), {
      requestJson: async (method: string, path: string, body: typeof policy) => {
        expect(path).toBe(`/v1/workspaces/workspace/model-connections/${kind}/account/access`);
        if (method === "PUT") {
          writes.push(structuredClone(body));
          policy = { ...body, version: policy.version + 1 };
          return policy;
        }
        return {
          policy,
          models: [
            { id: "model-a", label: "Model A" },
            { id: "model-b", label: "Model B" },
          ],
          workspaces: [],
          personalWorkspacesSupported: false,
        };
      },
    });
    function Page() {
      const [editing, setEditing] = useState(false);
      const access = useConnectionAccess({
        client,
        workspaceId: "workspace",
        kind,
        connectionId: "account",
      });
      return editing ? (
        <ConnectionAccessFormPage
          access={access}
          organization={false}
          canManage
          name="Team plan"
          onClose={() => setEditing(false)}
        />
      ) : (
        <ConnectionAccessRows
          access={access}
          organization={false}
          canManage
          onEdit={() => setEditing(true)}
        />
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const editor = () =>
      container.querySelector<HTMLButtonElement>('[data-slot="setting-nav-row"] button');
    const open = async () => {
      expect(editor()).not.toBeNull();
      await act(async () => editor()!.click());
      expect(container.querySelector("h1")?.textContent).toBe("Models Team plan can serve");
    };
    const choose = async (text: string) => {
      const radio = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
        (candidate) => candidate.textContent?.includes(text),
      );
      expect(radio).toBeDefined();
      await act(async () => radio!.click());
    };
    const save = async () => {
      const submit = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === "Save",
      );
      expect(submit?.disabled).toBe(false);
      await act(async () => submit!.closest("form")!.requestSubmit());
      await flush();
    };
    try {
      await act(async () => root.render(<Page />));
      await flush();
      expect(editor()?.textContent).toContain("Models it can serve");
      expect(editor()?.textContent).toContain("All models");
      await open();
      expect(container.textContent).not.toContain("Which workspaces can use it");
      await choose("Only the models I choose");
      const label = [...container.querySelectorAll("label")].find(
        (candidate) => candidate.textContent === "Model B",
      );
      expect(label).toBeDefined();
      await act(async () => document.getElementById(label!.htmlFor)!.click());
      await save();
      expect(writes).toEqual([
        {
          allowedModels: ["model-a"],
          allowedWorkspaces: null,
          allowPersonalWorkspaces: true,
          version: 1,
        },
      ]);
      expect(editor()?.textContent).toContain("1 model");

      await open();
      await choose("All models, including new ones");
      await save();
      expect(writes[1]).toEqual({
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: true,
        version: 2,
      });
      expect(writes).toHaveLength(2);
      expect(editor()?.textContent).toContain("All models");
      await open();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test(`${kind} workspace access remains read-only without manage permission`, async () => {
    const onEdit = mock(() => undefined);
    const update = mock(async () => ({}));
    const client = Object.assign(new OpenGeniBrowserClient({ baseUrl: "http://localhost" }), {
      getModelConnectionAccess: async () => ({
        policy: {
          allowedModels: null,
          allowedWorkspaces: null,
          allowPersonalWorkspaces: true,
          version: 1,
        },
        models: [{ id: "model-a", label: "Model A" }],
        workspaces: [],
        personalWorkspacesSupported: false,
      }),
      updateModelConnectionAccess: update,
    });
    function Page({ editing }: { editing: boolean }) {
      const access = useConnectionAccess({
        client,
        workspaceId: "workspace",
        kind,
        connectionId: "account",
      });
      return editing ? (
        <ConnectionAccessFormPage
          access={access}
          organization={false}
          canManage={false}
          name="Team plan"
          onClose={() => undefined}
        />
      ) : (
        <ConnectionAccessRows
          access={access}
          organization={false}
          canManage={false}
          onEdit={onEdit}
        />
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Page editing={false} />));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(container.textContent).toContain("Models it can serve");
      expect(container.textContent).toContain("All models");
      expect(container.querySelector('[data-slot="setting-nav-row"] button')).toBeNull();
      const row = container.querySelector<HTMLElement>('[aria-disabled="true"]');
      expect(row).not.toBeNull();
      await act(async () => row!.click());
      expect(onEdit).not.toHaveBeenCalled();

      // Direct navigation to the form must not bypass the same permission fence.
      await act(async () => root.render(<Page editing />));
      const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      expect(radios.length).toBe(2);
      expect([...radios].every((radio) => radio.disabled)).toBe(true);
      const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === "Save",
      );
      expect(save?.disabled).toBe(true);
      expect(update).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test(`${kind} saves individual workspace and model choices on the connection`, async () => {
    let policy = {
      allowedModels: null as string[] | null,
      allowedWorkspaces: null as string[] | null,
      allowPersonalWorkspaces: true,
      version: 1,
    };
    const writes: unknown[] = [];
    const client = Object.assign(new OpenGeniBrowserClient({ baseUrl: "http://localhost" }), {
      requestJson: async (method: string, path: string, body: typeof policy) => {
        expect(path).toBe(`/v1/organizations/org/model-connections/${kind}/account/access`);
        if (method === "PUT") {
          writes.push(body);
          policy = { ...body, version: 2 };
          return policy;
        }
        return {
          policy,
          models: [
            { id: "model-a", label: "Model A" },
            { id: "model-b", label: "Model B" },
          ],
          workspaces: [
            { id: "workspace-a", name: "Engineering" },
            { id: "workspace-b", name: "Finance" },
          ],
          personalWorkspacesSupported: kind === "codex" || kind === "supergrok",
        };
      },
    });
    let closed = 0;
    function Page({ editing }: { editing: boolean }) {
      const access = useConnectionAccess({
        client,
        organizationId: "org",
        kind,
        connectionId: "account",
      });
      return editing ? (
        <ConnectionAccessFormPage
          access={access}
          organization
          canManage
          name="Team plan"
          onClose={() => {
            closed += 1;
          }}
        />
      ) : (
        <ConnectionAccessRows access={access} organization canManage onEdit={() => undefined} />
      );
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const choose = async (text: string) =>
      act(async () => {
        const radio = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
          (candidate) => candidate.textContent?.includes(text),
        );
        const label = [...container.querySelectorAll("label")].find(
          (candidate) => candidate.textContent === text,
        );
        const target =
          radio ?? (label ? (document.getElementById(label.htmlFor) ?? undefined) : undefined);
        expect(target).toBeDefined();
        target!.click();
      });
    try {
      await act(async () => root.render(<Page editing={false} />));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      // The "Available in" and "Models it can serve" rows show short values.
      expect(container.textContent).toContain("Available in");
      expect(container.textContent).toContain(
        kind === "codex" || kind === "supergrok" ? "All workspaces + Personal" : "All workspaces",
      );
      if (kind !== "codex" && kind !== "supergrok")
        expect(container.textContent).not.toContain("+ Personal");
      expect(container.textContent).toContain("Models it can serve");
      expect(container.textContent).toContain("All models");

      await act(async () => root.render(<Page editing />));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(container.textContent).not.toContain("Engineering");
      // A response without the people fields keeps the workspace-only form.
      expect(container.textContent).toContain("Which workspaces can use it");
      expect(container.textContent).not.toContain("Only selected people");
      await choose("Only selected workspaces");
      expect(container.textContent).toContain("Finance");
      await choose("Finance");
      const modelsOnly = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].filter(
        (radio) => radio.textContent?.includes("Only the models I choose"),
      );
      await act(async () => modelsOnly[0]!.click());
      await choose("Model B");
      const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Save",
      )!;
      await act(async () => save.closest("form")!.requestSubmit());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(writes).toEqual([
        {
          allowedModels: ["model-a"],
          allowedWorkspaces: ["workspace-a"],
          allowPersonalWorkspaces: true,
          version: 1,
        },
      ]);
      expect(closed).toBe(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}

test("an organization account no workspace can use says so, on its tag, row and form", async () => {
  const access = (allowedWorkspaces: string[] | null, allowPersonalWorkspaces: boolean) => ({
    policy: { allowedModels: null, allowedWorkspaces, allowPersonalWorkspaces, version: 1 },
    models: [{ id: "model-a", label: "Model A" }],
    workspaces: [{ id: "workspace-a", name: "Engineering" }],
    personalWorkspacesSupported: true,
  });
  const labels = modelsScopeLabels("Acme", false);
  expect(organizationReachLabel(labels, access(null, true))).toBe("Everyone in Acme");
  // One workspace is named, as the Accounts list tags a workspace's own account.
  expect(organizationReachLabel(labels, access(["workspace-a"], false))).toBe("Engineering only");
  expect(organizationReachLabel(labels, access([], true))).toBe("Selected workspaces");
  expect(organizationReachLabel(labels, access([], false))).toBe("No workspaces");
  expect(organizationReachLabel(labels, null)).toBe("Shared by Acme");

  const client = Object.assign(new OpenGeniBrowserClient({ baseUrl: "http://localhost" }), {
    requestJson: async () => access([], false),
  });
  function Page({ editing }: { editing: boolean }) {
    const state = useConnectionAccess({
      client,
      organizationId: "org",
      kind: "codex",
      connectionId: "account",
    });
    return editing ? (
      <ConnectionAccessFormPage
        access={state}
        organization
        canManage
        name="Backup"
        onClose={() => undefined}
      />
    ) : (
      <ConnectionAccessRows access={state} organization canManage onEdit={() => undefined} />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  try {
    await act(async () => root.render(<Page editing={false} />));
    await settle();
    expect(container.textContent).toContain("No workspaces");
    expect(container.textContent).not.toContain("0 workspaces");

    await act(async () => root.render(<Page editing />));
    await settle();
    expect(container.textContent).toContain("No workspace can use it.");
    // Ticking a workspace clears the warning.
    const engineering = [...container.querySelectorAll("label")].find(
      (label) => label.textContent === "Engineering",
    )!;
    await act(async () => document.getElementById(engineering.htmlFor)!.click());
    expect(container.textContent).not.toContain("No workspace can use it.");
    // Limiting models and unticking the last one says it serves nothing.
    const modelsOnly = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (radio) => radio.textContent?.includes("Only the models I choose"),
    )!;
    await act(async () => modelsOnly.click());
    expect(container.textContent).not.toContain("can't serve any model");
    const modelA = [...container.querySelectorAll("label")].find(
      (label) => label.textContent === "Model A",
    )!;
    await act(async () => document.getElementById(modelA.htmlFor)!.click());
    expect(container.textContent).toContain("It can't serve any model until you choose one.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a refused or failed read says what to do, never the raw API error", async () => {
  let failure: Error = new OpenGeniApiError(
    403,
    JSON.stringify({ error: { message: "Subscription owner browser session required" } }),
    { correlationId: "corr-refused" },
  );
  const client = Object.assign(new OpenGeniBrowserClient({ baseUrl: "http://localhost" }), {
    requestJson: async () => {
      throw failure;
    },
  });
  function Page({ editing }: { editing: boolean }) {
    const access = useConnectionAccess({
      client,
      workspaceId: "workspace",
      kind: "supergrok",
      connectionId: "account",
    });
    return editing ? (
      <ConnectionAccessFormPage
        access={access}
        organization={false}
        canManage
        name="Private plan"
        onClose={() => undefined}
      />
    ) : (
      <ConnectionAccessRows
        access={access}
        organization={false}
        canManage
        onEdit={() => undefined}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const buttons = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].map((b) => b.textContent);
  try {
    // A refusal is calm: who can see it, no Try again, no API text.
    await act(async () => root.render(<Page editing={false} />));
    await flush();
    expect(container.textContent).toContain(
      "Only the person who connected this account can see this.",
    );
    expect(buttons()).not.toContain("Try again");
    await act(async () => root.render(<Page editing />));
    expect(container.textContent).toContain("You can't see what this account can serve.");
    expect(buttons()).not.toContain("Try again");
    expect(container.textContent).not.toContain("Opengeni API");
    expect(container.textContent).not.toContain("corr-refused");

    // A failure says what happened and what to do; the reference sits in Technical details.
    await act(async () => root.unmount());
    failure = new OpenGeniApiError(503, "", { correlationId: "corr-failed" });
    root = createRoot(container);
    await act(async () => root.render(<Page editing />));
    await flush();
    expect(container.textContent).toContain("Couldn't load what this account can serve.");
    expect(container.textContent).toContain("Try again in a moment.");
    expect(buttons()).toContain("Try again");
    expect(container.textContent).toContain("Technical details");
    expect(container.textContent).not.toContain("Opengeni API");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a workspace's own copy no workspace manages is an organization account: its workspace stays, people can be chosen", async () => {
  type Policy = {
    allowedModels: string[] | null;
    allowedWorkspaces: string[] | null;
    allowPersonalWorkspaces: boolean;
    allowedPeople?: string[] | null;
    version: number;
  };
  // Connected in Engineering: today only Engineering uses it.
  let policy: Policy = {
    allowedModels: null,
    allowedWorkspaces: [],
    allowPersonalWorkspaces: false,
    version: 1,
  };
  const writes: Policy[] = [];
  // Changed by the last two cases: a workspace manages it; the member list can't be read.
  let managedBy: string | null = null;
  let peopleReadable = true;
  const response = () => ({
    policy,
    models: [{ id: "model-a", label: "Model A" }],
    workspaces: [
      { id: "workspace-a", name: "Engineering" },
      { id: "workspace-b", name: "Finance" },
      { id: "workspace-c", name: "Legal" },
    ],
    personalWorkspacesSupported: true,
    peopleSupported: managedBy === null && peopleReadable,
    ...(peopleReadable
      ? {
          people: [
            { id: "person-a", name: "Alex Morgan", email: "alex@example.com" },
            { id: "person-b", name: null, email: "sam@example.com" },
          ],
        }
      : {}),
    localWorkspaceIds: ["workspace-a"],
    managedByWorkspaceId: managedBy,
  });
  const labels = modelsScopeLabels("Acme", false);
  expect(organizationReachLabel(labels, response())).toBe("Engineering only");
  expect(workspacesShort(policy, true, ["workspace-a"])).toBe("1 workspace");
  expect(
    workspacesShort({ ...policy, allowedPeople: ["person-a", "person-b"] }, true, ["workspace-a"]),
  ).toBe("2 people");
  expect(
    organizationReachLabel(labels, {
      ...response(),
      policy: { ...policy, allowedPeople: ["person-a"] },
    }),
  ).toBe("Selected people");
  // Nobody chosen says so, like an account no workspace can use.
  expect(
    organizationReachLabel(labels, { ...response(), policy: { ...policy, allowedPeople: [] } }),
  ).toBe("No one");
  expect(workspacesShort({ ...policy, allowedPeople: [] }, true)).toBe("No one");

  const client = Object.assign(new OpenGeniBrowserClient({ baseUrl: "http://localhost" }), {
    requestJson: async (method: string, _path: string, body: Policy) => {
      if (method === "PUT") {
        writes.push(structuredClone(body));
        // Stored and returned in the response schema's key order, as the API does.
        policy = {
          allowedModels: body.allowedModels,
          allowedWorkspaces: body.allowedWorkspaces,
          allowPersonalWorkspaces: body.allowPersonalWorkspaces,
          ...(body.allowedPeople === undefined ? {} : { allowedPeople: body.allowedPeople }),
          version: policy.version + 1,
        };
        return policy;
      }
      return response();
    },
  });
  function Page() {
    const access = useConnectionAccess({
      client,
      organizationId: "org",
      kind: "codex",
      connectionId: "account",
    });
    return (
      <ConnectionAccessFormPage
        access={access}
        organization
        canManage
        name="Team plan"
        onClose={() => undefined}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const choose = async (text: string) =>
    act(async () => {
      const radio = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
        (candidate) => candidate.textContent?.includes(text),
      );
      const label = [...container.querySelectorAll("label")].find(
        (candidate) => candidate.textContent === text,
      );
      const target =
        radio ?? (label ? (document.getElementById(label.htmlFor) ?? undefined) : undefined);
      expect(target).toBeDefined();
      target!.click();
    });
  const save = async () => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === "Save",
    )!;
    await act(async () => button.closest("form")!.requestSubmit());
    await flush();
  };
  try {
    await act(async () => root.render(<Page />));
    await flush();
    // Its workspace is shown included and can't be cleared.
    expect(container.textContent).toContain(
      "Connected in this workspace, which keeps it as its own.",
    );
    expect(container.textContent).not.toContain("No workspace can use it");
    await choose("Finance");
    await save();
    expect(writes.at(-1)).toEqual({
      allowedModels: null,
      allowedWorkspaces: ["workspace-b"],
      allowPersonalWorkspaces: false,
      version: 1,
    });

    // "All" and back to chosen workspaces restores the saved choice, not all.
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Page />));
    await flush();
    const saveDisabled = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === "Save",
      )!.disabled;
    await choose("All shared workspaces, including new ones");
    expect(saveDisabled()).toBe(false);
    await choose("Only selected workspaces");
    expect(saveDisabled()).toBe(true);

    // Chosen people replace workspaces; Personal is not a separate choice then.
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Page />));
    await flush();
    await choose("Only selected people");
    expect(container.textContent).not.toContain("Personal workspaces");
    expect(container.textContent).toContain("No one can use it.");
    await choose("Alex Morgan");
    await choose("sam@example.com");
    await save();
    expect(writes.at(-1)).toEqual({
      allowedModels: null,
      allowedWorkspaces: [],
      allowPersonalWorkspaces: false,
      allowedPeople: ["person-a", "person-b"],
      version: 2,
    });

    // Going back to workspaces clears the people explicitly.
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Page />));
    await flush();
    // Leaving and returning to the same people is no change.
    const saveButton = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === "Save",
      )!;
    await choose("All shared workspaces, including new ones");
    expect(saveButton().disabled).toBe(false);
    await choose("Only selected people");
    expect(saveButton().disabled).toBe(true);
    // From saved people, chosen workspaces start empty, never from all of them.
    await choose("Only selected workspaces");
    await save();
    expect(writes.at(-1)).toEqual({
      allowedModels: null,
      allowedWorkspaces: [],
      allowPersonalWorkspaces: false,
      allowedPeople: null,
      version: 3,
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Page />));
    await flush();
    await choose("All shared workspaces, including new ones");
    await save();
    expect(writes.at(-1)).toEqual({
      allowedModels: null,
      allowedWorkspaces: null,
      allowPersonalWorkspaces: false,
      version: 4,
    });

    // From all, chosen workspaces start from every shared one except its own.
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Page />));
    await flush();
    await choose("Only selected workspaces");
    await choose("Legal");
    await choose("Personal workspaces");
    await save();
    expect(writes.at(-1)).toEqual({
      allowedModels: null,
      allowedWorkspaces: ["workspace-b"],
      allowPersonalWorkspaces: true,
      version: 5,
    });

    // Through people and back restores the saved Personal choice: no change.
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Page />));
    await flush();
    await choose("Only selected people");
    expect(saveButton().disabled).toBe(false);
    await choose("Only selected workspaces");
    expect(saveButton().disabled).toBe(true);

    // People saved earlier stay chosen when the member list can't be read.
    policy = {
      ...policy,
      allowedWorkspaces: [],
      allowPersonalWorkspaces: false,
      allowedPeople: ["person-a", "person-b"],
    };
    peopleReadable = false;
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Page />));
    await flush();
    expect(container.textContent).toContain("2 people chosen.");
    expect(container.textContent).not.toContain("Former member");
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
      "Only selected people",
    );
    await choose("Only selected workspaces");
    await choose("Only selected people");
    expect(saveButton().disabled).toBe(true);

    // A workspace manages it: no people choice (the server refuses one).
    policy = { ...policy, allowedPeople: null };
    peopleReadable = true;
    managedBy = "workspace-a";
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Page />));
    await flush();
    expect(container.textContent).not.toContain("Only selected people");
    expect(container.textContent).toContain("Which workspaces can use it");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
