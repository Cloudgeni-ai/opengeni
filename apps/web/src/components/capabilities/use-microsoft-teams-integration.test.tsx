import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniApiError, OpenGeniClient } from "@opengeni/sdk";
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
const { savePendingTeamsSetup } = await import("@/lib/teams-connect");

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
    // An operator-approved installer needs no Microsoft sign-in.
    if (String(args[1]).endsWith("/microsoft-sign-in")) return { authorizationUrl: null };
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
    expect(requests.map((request) => request.slice(0, 3))).toEqual([
      [
        "POST",
        `/v1/workspaces/${ws}/integrations/teams/bot/microsoft-sign-in`,
        { setupToken: "setup-proof" },
      ],
      ["PUT", `/v1/workspaces/${ws}/integrations/teams/bot`, { setupToken: "setup-proof" }],
    ]);
    expect(window.location.hash).toBe("");
    expect(view.container.textContent).toContain("Teams is connected");
    await act(async () => {
      window.history.replaceState(null, "", "/teams/connect#teams_setup=replacement-proof");
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(view.container.textContent).toContain("Connect Teams to Opengeni");
    expect(requests).toHaveLength(2);
    await act(async () =>
      view.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(requests[2]?.[2]).toEqual({ setupToken: "replacement-proof" });
    expect(requests[3]?.[2]).toEqual({ setupToken: "replacement-proof" });
  } finally {
    await view.cleanup();
  }
});

test("self-serve setup signs in with Microsoft, then finishes on return with the code", async () => {
  window.history.replaceState(null, "", "/teams/connect#teams_setup=setup-proof");
  const authorizationUrl = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?x=1";
  const requests: any[][] = [];
  prepare(async (...args) => {
    requests.push(args);
    if (String(args[1]).endsWith("/microsoft-sign-in")) return { authorizationUrl };
    return {};
  });
  const assigned: string[] = [];
  const assign = window.location.assign;
  Object.defineProperty(window.location, "assign", {
    configurable: true,
    value: (url: string) => assigned.push(url),
  });
  const view = await render(<TeamsConnectRoute />);
  try {
    await act(async () =>
      view.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(assigned).toEqual([authorizationUrl]);
    expect(requests.map((request) => request[0])).toEqual(["POST"]);
  } finally {
    await view.cleanup();
    Object.defineProperty(window.location, "assign", { configurable: true, value: assign });
  }
  // Microsoft returns to the setup page in the same tab.
  window.history.replaceState(null, "", "/teams/connect?code=microsoft-code&state=signed-state");
  const returned = await render(<TeamsConnectRoute />);
  try {
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(requests.at(-1)?.slice(0, 3)).toEqual([
      "PUT",
      `/v1/workspaces/${ws}/integrations/teams/bot`,
      { setupToken: "setup-proof", microsoft: { code: "microsoft-code", state: "signed-state" } },
    ]);
    expect(window.location.search).toBe("");
    expect(returned.container.textContent).toContain("Teams is connected");
  } finally {
    await returned.cleanup();
  }
  // The code and the pending setup are single-use.
  window.history.replaceState(null, "", "/teams/connect?code=microsoft-code&state=signed-state");
  const reloaded = await render(<TeamsConnectRoute />);
  try {
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(requests).toHaveLength(2);
    expect(reloaded.container.textContent).toContain("get a new setup link");
  } finally {
    await reloaded.cleanup();
    window.history.replaceState(null, "", "/teams/connect");
  }
});

/** A Teams setup refusal as the API sends it. */
function setupRefusal(status: number, reason: string, message: string) {
  return new OpenGeniApiError(
    status,
    JSON.stringify({
      error: {
        status,
        code: status === 403 ? "forbidden" : "conflict",
        message,
        retryable: false,
        requestId: "e0848c37-0000-4000-8000-000000000000",
        details: { code: "teams_connection_refused", reason },
      },
    }),
    { mutation: true },
  );
}
async function submit(view: { container: HTMLElement }) {
  await act(async () => {
    view.container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("setup shows the API's own refusal, not generic permission or conflict text", async () => {
  const notAdmin =
    "Only a Microsoft 365 Global Administrator or Teams Administrator can connect your organization. Ask your admin to message Opengeni in Teams and select Connect your organization. If your admin role must be activated first, activate it and try again.";
  const moveRefused =
    "This Teams organization was connected to another workspace and is disconnected. Reconnect it in that workspace, or ask a Microsoft 365 Global Administrator to connect it here.";
  let refusal = setupRefusal(403, "not_tenant_admin", notAdmin);
  prepare(async (...args) => {
    if (String(args[1]).endsWith("/microsoft-sign-in")) return { authorizationUrl: "https://x" };
    throw refusal;
  });
  for (const [error, text] of [
    [setupRefusal(403, "not_tenant_admin", notAdmin), notAdmin],
    [setupRefusal(409, "move_requires_global_admin", moveRefused), moveRefused],
  ] as const) {
    refusal = error;
    // Back from Microsoft with the pending setup of this tab.
    savePendingTeamsSetup({ setupToken: "setup-proof", workspaceId: ws });
    window.history.replaceState(null, "", "/teams/connect?code=microsoft-code&state=signed-state");
    const view = await render(<TeamsConnectRoute />);
    try {
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(text);
      expect(view.container.textContent).not.toContain("You don't have permission");
      expect(view.container.textContent).not.toContain("It changed since this page loaded");
      // Nothing else to undo: the only action starts setup again.
      expect(view.container.querySelector('button[type="submit"]')?.textContent).toContain(
        "Connect workspace",
      );
    } finally {
      await view.cleanup();
    }
  }
  window.history.replaceState(null, "", "/teams/connect");
});

test("an account already linked to another Teams account can unlink it and connect", async () => {
  window.history.replaceState(null, "", "/teams/connect#teams_setup=setup-proof");
  const linked =
    "Your Opengeni account is already linked to a different Teams account in this workspace. Unlink it and connect again, or sign in to Opengeni with another account.";
  const requests: any[][] = [];
  let unlinked = false;
  prepare(async (...args) => {
    requests.push(args.slice(0, 3));
    if (String(args[1]).endsWith("/microsoft-sign-in")) return { authorizationUrl: null };
    if (args[0] === "DELETE") {
      unlinked = true;
      return { ok: true };
    }
    if (!unlinked) throw setupRefusal(409, "opengeni_account_linked", linked);
    return {};
  });
  const view = await render(<TeamsConnectRoute />);
  try {
    // The test DOM reports the fragment set above as a late hashchange.
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    await submit(view);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(linked);
    const button = view.container.querySelector('button[type="submit"]')!;
    expect(button.textContent).toContain("Unlink and connect");
    expect(requests).toHaveLength(2);
    await submit(view);
    expect(requests.slice(2)).toEqual([
      ["DELETE", `/v1/workspaces/${ws}/integrations/teams/link`],
      [
        "POST",
        `/v1/workspaces/${ws}/integrations/teams/bot/microsoft-sign-in`,
        { setupToken: "setup-proof" },
      ],
      ["PUT", `/v1/workspaces/${ws}/integrations/teams/bot`, { setupToken: "setup-proof" }],
    ]);
    expect(view.container.textContent).toContain("Teams is connected");
  } finally {
    await view.cleanup();
    window.history.replaceState(null, "", "/teams/connect");
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

test("a refused account link says which account is already linked and what to do", async () => {
  window.history.replaceState(null, "", `/workspaces/${ws}/plugins`);
  const linked =
    "Your Opengeni account is already linked to a different Teams account in this workspace. Unlink it and connect again, or sign in to Opengeni with another account.";
  prepare(async (...args) => {
    if (args[0] === "POST") throw setupRefusal(409, "opengeni_account_linked", linked);
    return {
      enabled: true,
      configured: true,
      setupAvailable: true,
      installation: { active: true, workspaceId: ws, tenantId: "tenant" },
      linked: true,
    };
  });
  function Harness() {
    return useTeamsBotIntegration({ workspaceId: ws }).dialogs;
  }
  const view = await render(<Harness />);
  try {
    await act(async () => {
      window.history.replaceState(null, "", `/workspaces/${ws}/plugins#teams_link=link-proof`);
      window.dispatchEvent(new Event("hashchange"));
      // The test DOM also reports the fragment as a late hashchange.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      [...view.container.querySelectorAll("button")]
        .find((b) => b.textContent === "Link my account")!
        .click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(linked);
  } finally {
    await view.cleanup();
    window.history.replaceState(null, "", "/teams/connect");
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
