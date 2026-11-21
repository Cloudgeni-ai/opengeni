import { describe, expect, test } from "bun:test";
import { actRun, registerDom, renderComponent } from "../../../test/render-hook";

registerDom();
const {
  AppSharedKeyDialogView,
  addSharedServiceKey,
  sharedKeyHeaderDefaults,
  sharedKeyHeaders,
  sharedKeyVaults,
} = await import("./app-shared-key-dialog");

const REFERENCE = "{{secret:Team/Stripe}}";

describe("Add a shared key", () => {
  test("only workspace and organization vaults, never Only me or a task's", () => {
    const vault = (id: string, ownerKind: "user" | "workspace" | "organization" | "task") =>
      ({ id, ownerKind, name: id }) as never;
    expect(
      sharedKeyVaults([
        vault("mine", "user"),
        vault("team", "workspace"),
        vault("org", "organization"),
        vault("chat", "task"),
      ]).map((entry: { id: string }) => entry.id),
    ).toEqual(["team", "org"]);
  });

  test("the header follows the connector's contract, else a bearer token", () => {
    expect(sharedKeyHeaderDefaults(null)).toEqual({
      headerName: "Authorization",
      scheme: "Bearer",
    });
    expect(
      sharedKeyHeaderDefaults({
        metadata: { authContract: { headerName: "X-Api-Key", scheme: "raw" } },
      }),
    ).toEqual({ headerName: "X-Api-Key", scheme: "" });
    expect(
      sharedKeyHeaders({ headerName: "Authorization", scheme: "Bearer", reference: REFERENCE }),
    ).toEqual({
      Authorization: `Bearer ${REFERENCE}`,
    });
    expect(
      sharedKeyHeaders({ headerName: " X-Api-Key ", scheme: "", reference: REFERENCE }),
    ).toEqual({
      "X-Api-Key": REFERENCE,
    });
  });

  test("connects for the workspace with the reference, never a value", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const api = {
      request: async <T,>(path: string, init?: RequestInit) => {
        calls.push({ path, body: JSON.parse(String(init?.body)) });
        return (
          path.endsWith("/advance")
            ? { id: "attempt", revision: 2, state: "complete" }
            : { id: "attempt", revision: 1, state: "pending" }
        ) as T;
      },
    };
    await addSharedServiceKey(api, {
      workspaceId: "w",
      mcpUrl: "https://mcp.example/mcp",
      headers: { Authorization: `Bearer ${REFERENCE}` },
      returnUrl: "https://console.example/",
    });
    expect(calls[0]).toMatchObject({
      path: "/v1/workspaces/w/connect/attempts",
      body: { providerId: "mcp-headers", ownership: "workspace" },
    });
    expect(calls[1]).toMatchObject({
      path: "/v1/workspaces/w/connect/attempts/attempt/advance",
      body: {
        expectedRevision: 1,
        action: {
          type: "credentials",
          values: {
            mcpUrl: "https://mcp.example/mcp",
            headers: JSON.stringify({ Authorization: `Bearer ${REFERENCE}` }),
          },
        },
      },
    });

    const failing = {
      request: async <T,>(path: string) =>
        (path.endsWith("/advance")
          ? { id: "a", revision: 2, state: "failed", error: { message: "Nope." } }
          : { id: "a", revision: 1, state: "pending" }) as T,
    };
    await expect(
      addSharedServiceKey(failing, {
        workspaceId: "w",
        mcpUrl: "https://mcp.example/mcp",
        headers: {},
        returnUrl: "https://console.example/",
      }),
    ).rejects.toThrow("Nope.");
  });

  test("the dialog saves once an item is chosen", async () => {
    let saved = 0;
    const props = {
      connector: "Stripe",
      vaults: [{ id: "team", name: "Team", ownerKind: "workspace" }] as never,
      items: [{ id: "item", name: "Stripe key", references: { primary: REFERENCE } }] as never,
      vaultId: "team",
      headerName: "Authorization",
      onVaultChange: () => undefined,
      onItemChange: () => undefined,
      onHeaderNameChange: () => undefined,
      onSave: () => {
        saved += 1;
      },
      onCancel: () => undefined,
    };
    const view = await renderComponent(<AppSharedKeyDialogView {...props} itemId={null} />);
    const dialog = () => document.body.querySelector<HTMLElement>("[data-app-shared-key-dialog]")!;
    expect(dialog().textContent).toContain("Add a shared key for Stripe");
    const save = () =>
      [...dialog().querySelectorAll("button")].find((button) => button.textContent === "Save")!;
    expect(save().disabled).toBe(true);
    await view.unmount();
    const ready = await renderComponent(<AppSharedKeyDialogView {...props} itemId="item" />);
    expect(save().disabled).toBe(false);
    await actRun(() => save().click());
    expect(saved).toBe(1);
    await ready.unmount();
  });
});
