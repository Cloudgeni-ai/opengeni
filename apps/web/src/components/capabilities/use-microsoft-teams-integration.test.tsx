import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniClient } from "@opengeni/sdk";
import type { IntegrationViewModel } from "@opengeni/react/app/components/capabilities/integration-view-model";

const ws = "33333333-3333-4333-8333-333333333333";
const subjectId = "teams-test-human";
const context: { current: any } = { current: {} };
mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context.current }));
mock.module("@opengeni/react/app/components/capabilities/native-connect-setup", () => ({
  NativeConnectSetup: ({ request }: any) => <div data-ownership={request.ownership} />,
}));
mock.module("@opengeni/react/ui/dialog", () => ({
  Dialog: ({ open, children }: any) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <footer>{children}</footer>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));
const { useMicrosoftTeamsIntegration } = await import("./use-microsoft-teams-integration");
const { useTeamsBotIntegration } = await import("./use-teams-bot-integration");
const { TeamsConnectRoute } = await import("../../routes/teams-connect");

beforeAll(() => {
  GlobalRegistrator.register({ url: "https://app.example.test/teams/connect" });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

function prepare(requestJson: (...args: any[]) => Promise<any>) {
  context.current = {
    client: {
      requestJson,
      connectTransport: () =>
        new OpenGeniClient({ baseUrl: "https://app.example.test" }).connectTransport(),
    },
    accessContext: {
      subjectId,
      workspaceGrants: [
        {
          workspaceId: ws,
          subjectId,
          accountId: "org",
          permissions: ["workspace:admin", "capabilities:manage"],
        },
      ],
      accountGrants: [],
    },
    workspaces: [
      { id: ws, name: "Engineering", kind: "shared" },
      { id: "personal", name: "Personal", kind: "personal" },
    ],
  };
}
async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("new Teams Graph accounts go directly to personal setup without offering workspace ownership", async () => {
  prepare(async () => ({}));
  let model: IntegrationViewModel | undefined;
  function Harness() {
    const adapter = useMicrosoftTeamsIntegration({
      workspaceId: ws,
      instances: [],
      definitions: [
        {
          id: "microsoft-teams",
          name: "Microsoft Teams",
          summary: "Teams messages",
          protocol: "openapi",
          provider: { id: "microsoft", domain: "graph.microsoft.com" },
          authentication: { kind: "oauth2", scopes: ["Chat.Read"] },
          facets: [],
        },
      ],
    });
    model = adapter.model;
    return adapter.dialogs;
  }
  const view = await render(<Harness />);
  try {
    expect(model?.id).toBe("microsoft-teams");
    await act(async () => {
      if (model?.footer.kind === "setup") model.footer.onSetup();
    });
    expect(view.container.querySelector("[data-ownership]")?.getAttribute("data-ownership")).toBe(
      "personal",
    );
    expect(view.container.textContent).not.toContain("Share with workspace");
  } finally {
    await view.cleanup();
  }
});

test("setup never submits on page load and only sends the proof after explicit shared-workspace choice", async () => {
  window.history.replaceState(null, "", "/teams/connect#teams_setup=setup-proof");
  const requests: any[][] = [];
  prepare(async (...args) => {
    requests.push(args);
    return {};
  });
  const view = await render(<TeamsConnectRoute />);
  try {
    expect(requests).toHaveLength(0);
    const select = view.container.querySelector("select")!;
    expect(select.value).toBe(ws);
    expect([...select.options].map((option) => option.text)).toEqual([
      "Choose a workspace",
      "Engineering",
    ]);
    await act(async () => {
      select.value = ws;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      view.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.slice(0, 3)).toEqual([
      "PUT",
      `/v1/workspaces/${ws}/integrations/teams/bot`,
      { setupToken: "setup-proof" },
    ]);
    expect(window.location.hash).toBe("");
    expect(view.container.textContent).toContain("Teams is connected");
    await act(async () => {
      window.history.replaceState(null, "", "/teams/connect#teams_setup=replacement-proof");
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(view.container.textContent).toContain("Connect Teams to Opengeni");
    expect(requests).toHaveLength(1);
    await act(async () =>
      view.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(requests[1]?.[2]).toEqual({ setupToken: "replacement-proof" });
  } finally {
    await view.cleanup();
  }
});

test("bot link requires confirmation and default-off unconfigured bot stays hidden", async () => {
  window.history.replaceState(null, "", `/workspaces/${ws}/plugins`);
  const requests: any[][] = [];
  let linked = false;
  prepare(async (...args) => {
    requests.push(args);
    if (args[0] === "POST") {
      linked = true;
      return { ok: true };
    }
    return { enabled: false, configured: false, setupAvailable: false, installation: null, linked };
  });
  let visible = false;
  function Harness() {
    const adapter = useTeamsBotIntegration({ workspaceId: ws });
    visible = adapter.visible;
    return adapter.dialogs;
  }
  const view = await render(<Harness />);
  try {
    expect(visible).toBe(false);
    await act(async () => {
      window.history.replaceState(null, "", `/workspaces/${ws}/plugins#teams_link=link-proof`);
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(requests.filter((r) => r[0] === "POST")).toHaveLength(0);
    expect(view.container.textContent).toContain("Link your Teams account?");
    await act(async () =>
      [...view.container.querySelectorAll("button")]
        .find((b) => b.textContent === "Link my account")!
        .click(),
    );
    expect(requests.find((r) => r[0] === "POST")?.slice(0, 3)).toEqual([
      "POST",
      `/v1/workspaces/${ws}/integrations/teams/link`,
      { token: "link-proof" },
    ]);
    expect(window.location.hash).toBe("");
    expect(visible).toBe(false);
  } finally {
    await view.cleanup();
  }
});

test("setup without an eligible workspace cannot submit and gives an access recovery path", async () => {
  window.history.replaceState(null, "", "/teams/connect#teams_setup=setup-proof");
  const requests: any[][] = [];
  prepare(async (...args) => {
    requests.push(args);
    return {};
  });
  context.current.workspaces = [{ id: "personal", name: "Personal", kind: "personal" }];
  const view = await render(<TeamsConnectRoute />);
  try {
    expect(view.container.textContent).toContain("Ask your organization owner");
    expect(view.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
    await act(async () =>
      view.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(requests).toHaveLength(0);
  } finally {
    await view.cleanup();
  }
});

test("a failed bot status stays visible with retry and recovers without reconnecting", async () => {
  window.history.replaceState(null, "", `/workspaces/${ws}/plugins`);
  let failed = true;
  prepare(async () => {
    if (failed) throw new TypeError("Failed to fetch");
    return {
      enabled: true,
      configured: true,
      setupAvailable: true,
      installation: { active: true, workspaceId: ws, tenantId: "tenant" },
      linked: false,
    };
  });
  let adapter: ReturnType<typeof useTeamsBotIntegration> | undefined;
  function Harness() {
    adapter = useTeamsBotIntegration({ workspaceId: ws });
    return adapter.dialogs;
  }
  const view = await render(<Harness />);
  try {
    expect(adapter?.visible).toBe(true);
    expect(adapter?.model.chip.label).toBe("Unavailable");
    expect(adapter?.model.notice?.action?.label).toBe("Retry");
    failed = false;
    await act(async () => adapter?.model.notice?.action?.onClick());
    expect(adapter?.model.chip.label).toBe("Connected");
    expect(adapter?.model.notice).toBeUndefined();
  } finally {
    await view.cleanup();
  }
});
