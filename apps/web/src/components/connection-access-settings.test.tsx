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

const { ConnectionAccessFormPage, ConnectionAccessRows, useConnectionAccess } =
  await import("./connection-access-settings");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

for (const kind of ["codex", "supergrok", "vercel_gateway", "openrouter"] as const) {
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
      await choose("Only the workspaces I choose");
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
    expect(container.textContent).not.toContain("OpenGeni API");
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
    expect(container.textContent).not.toContain("OpenGeni API");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
