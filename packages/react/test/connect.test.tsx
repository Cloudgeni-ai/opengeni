import { expect, test } from "bun:test";
import { ConnectController, type ConnectAttempt, type ConnectTransport } from "@opengeni/connect";
import { ConnectSetup, useConnect } from "../src/connect";
import { registerDom, renderHook, renderComponent, actRun } from "./render-hook";

registerDom();

test("setup clears submitted secrets from the DOM and does not store them in snapshots", async () => {
  const attempt: ConnectAttempt = {
    id: "credentials",
    workspaceId: "workspace",
    providerId: "provider",
    ownership: "personal",
    revision: 1,
    state: "credential_input",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    expiresAt: "2030-01-01T00:00:00Z",
    nextAction: {
      type: "credentials",
      fields: [{ name: "token", label: "Access token", secret: true, required: true }],
    },
  };
  let submitted: unknown;
  let finish!: (value: ConnectAttempt) => void;
  const transport: ConnectTransport = {
    catalog: async () => [],
    accounts: async () => [],
    pending: async () => [],
    begin: async () => attempt,
    get: async () => attempt,
    advance: async (_workspace, _id, input) => {
      submitted = input.action;
      return new Promise<ConnectAttempt>((resolve) => {
        finish = resolve;
      });
    },
    cancel: async () => attempt,
    disconnect: async () => {},
  };
  const controller = new ConnectController(transport, "workspace");
  const replacement = new ConnectController(transport, "workspace");
  await controller.recover(attempt.id);
  const rendered = await renderComponent(
    <ConnectSetup controller={controller} onAuthorize={() => {}} />,
  );
  try {
    const previousInput = rendered.container.querySelector("input")!;
    previousInput.value = "previous-actor-unsent-secret";
    await replacement.recover(attempt.id);
    await rendered.rerender(<ConnectSetup controller={replacement} onAuthorize={() => {}} />);
    expect(rendered.container.querySelector("input")!.value).toBe("");
    expect(rendered.container.contains(previousInput)).toBe(false);
    const input = rendered.container.querySelector("input")!;
    input.value = "synthetic-test-secret";
    await actRun(() => {
      rendered.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submitted).toEqual({ type: "credentials", values: { token: "synthetic-test-secret" } });
    expect(input.value).toBe("");
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("synthetic-test-secret");
    expect(JSON.stringify(replacement.getSnapshot())).not.toContain("synthetic-test-secret");
    expect(rendered.container.querySelector("fieldset")?.disabled).toBe(true);
    await actRun(() =>
      finish({
        ...attempt,
        revision: 2,
        state: "complete",
        credentialsCommitted: true,
        nextAction: { type: "none" },
      }),
    );
    expect(rendered.container.querySelector("form")).toBeNull();
  } finally {
    await rendered.unmount();
    controller.dispose();
    replacement.dispose();
  }
});

test("React observes the shared controller without owning durable attempt lifetime", async () => {
  const attempt: ConnectAttempt = {
    id: "attempt",
    workspaceId: "workspace",
    providerId: "provider",
    ownership: "personal",
    revision: 1,
    state: "connected_but_incomplete",
    credentialsCommitted: true,
    integrationInstalled: false,
    completionRequirement: "integration",
    nextAction: { type: "none" },
    expiresAt: "2027-01-01T00:00:00Z",
  };
  const transport: ConnectTransport = {
    catalog: async () => [],
    accounts: async () => [],
    pending: async () => [attempt],
    begin: async () => attempt,
    get: async () => attempt,
    advance: async () => attempt,
    cancel: async () => attempt,
    disconnect: async () => {},
  };
  const controller = new ConnectController(transport, "workspace");
  const hook = await renderHook(() => useConnect(controller), undefined);
  await actRun(() => controller.recover("attempt"));
  expect(hook.result.current.attempt?.state).toBe("connected_but_incomplete");
  await hook.unmount();
  expect((await controller.refresh()).id).toBe("attempt");
  controller.dispose();
});
