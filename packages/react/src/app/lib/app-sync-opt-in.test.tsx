import { describe, expect, mock, test } from "bun:test";
import { actRun, registerDom, renderComponent } from "../../../test/render-hook";

registerDom();

type Call = { path: string; method: string; body: unknown };
const calls: Call[] = [];
const responses: Record<string, unknown> = {};
const api = {
  apiBaseUrl: "",
  request: async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : null });
    const answer = responses[`${method} ${path}`];
    if (answer instanceof Error) throw answer;
    return answer ?? {};
  },
  requestResponse: async () => new Response("{}"),
};
mock.module("./app-api", () => ({ useAppApi: () => api }));

const { AppSyncJoinCard, AppSyncJoinCardView, AppSyncOptInHost, requestSiteSyncOptIn } =
  await import("./app-sync-opt-in");

const base = "/v1/workspaces/ws/published-artifacts/site";
const review = {
  syncId: "s-1",
  name: "My orders",
  mode: "personal",
  collection: "orders",
  tool: { toolName: "list_orders", connector: "Orders" },
  accounts: [
    { id: "account-a", label: "Orders (a@example.com)", connector: "Orders", shared: false },
    { id: "account-b", label: "Orders (b@example.com)", connector: "Orders", shared: false },
  ],
  account: null,
  optedIn: false,
  blocked: null,
};

const settle = async () => {
  for (let i = 0; i < 5; i++) await actRun(() => new Promise((resolve) => setTimeout(resolve, 0)));
};

describe("personal sync opt-in in the console", () => {
  test("the join card has one Join button per sync and a close button", async () => {
    const joined: string[] = [];
    const view = await renderComponent(
      <AppSyncJoinCardView
        syncs={[{ id: "s-1", name: "My orders" }]}
        onJoin={(id) => joined.push(id)}
        onDismiss={() => undefined}
      />,
    );
    const card = document.body.querySelector<HTMLElement>("[data-app-sync-join-card]")!;
    expect(card.getAttribute("aria-label")).toBe("Personal syncs for this app");
    await actRun(() => card.querySelector("button")!.click());
    expect(joined).toEqual(["s-1"]);
    await view.unmount();
  });

  test("an App's optIn opens the platform confirmation; only Join posts the opt-in", async () => {
    calls.length = 0;
    responses[`GET ${base}/syncs/s-1/opt-in`] = review;
    responses[`GET ${base}/data/syncs`] = {
      syncs: [
        { id: "s-1", name: "My orders", mode: "personal", active: true, optedIn: false },
        { id: "s-2", name: "Shared", mode: "shared", active: true, optedIn: null },
      ],
    };
    const view = await renderComponent(
      <>
        <AppSyncJoinCard workspaceId="ws" siteId="site" />
        <AppSyncOptInHost workspaceId="ws" siteId="site" />
      </>,
    );
    await settle();
    // Only the personal sync the viewer hasn't joined is listed.
    const card = document.body.querySelector<HTMLElement>("[data-app-sync-join-card]")!;
    expect([...card.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Join My orders",
      "",
    ]);

    // Cancel: nothing is posted, and the App hears optedIn: false.
    let result = requestSiteSyncOptIn("site", "s-1", true);
    await settle();
    const dialog = () => document.body.querySelector<HTMLElement>("[data-app-sync-opt-in]");
    expect(document.body.textContent).toContain("Join My orders?");
    expect(document.body.textContent).toContain("from your Orders account");
    expect(document.body.textContent).toContain("orders");
    const cancel = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    )!;
    await actRun(() => cancel.click());
    expect(await result).toEqual({ optedIn: false });
    expect(calls.some((call) => call.method === "PUT")).toBe(false);

    // Join with the second account.
    result = requestSiteSyncOptIn("site", "s-1", true);
    await settle();
    const select = dialog()!.querySelector<HTMLSelectElement>("select")!;
    await actRun(() => {
      select.value = "account-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const join = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Join",
    )!;
    await actRun(() => join.click());
    expect(await result).toEqual({ optedIn: true });
    expect(calls.find((call) => call.method === "PUT")).toEqual({
      path: `${base}/syncs/s-1/subscription`,
      method: "PUT",
      body: { account: "account-b" },
    });

    // Leaving needs no confirmation.
    expect(await requestSiteSyncOptIn("site", "s-1", false)).toEqual({ optedIn: false });
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([
      { path: `${base}/syncs/s-1/subscription`, method: "DELETE", body: null },
    ]);
    await settle();
    await view.unmount();

    // Without the console's host on screen the App's request fails readably.
    await expect(requestSiteSyncOptIn("site", "s-1", true)).rejects.toThrow("Opengeni");
  });
});
