import { expect, test } from "bun:test";
import { ConnectController, type ConnectProvider, type ConnectTransport } from "@opengeni/connect";
import { ConnectChooser } from "../src/connect";
import { actRun, registerDom, renderComponent } from "./render-hook";
registerDom();
const provider: ConnectProvider = {
  id: "ready",
  label: "Provider",
  family: "oauth",
  readiness: "available",
  ownership: ["personal", "workspace"],
  setup: ["oauth"],
};
function transport(
  catalog: ConnectTransport["catalog"],
  begin?: ConnectTransport["begin"],
): ConnectTransport {
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected operation");
  };
  return {
    catalog,
    begin: begin ?? unused,
    accounts: unused,
    pending: unused,
    get: unused,
    advance: unused,
    cancel: unused,
    disconnect: unused,
  };
}
test("chooser requires ready provider and explicit ownership and forwards exact return", async () => {
  let submitted: unknown;
  const controller = new ConnectController(
    transport(
      async () => [provider, { ...provider, id: "disabled", readiness: "needs_configuration" }],
      async (workspaceId, input) => {
        submitted = input;
        return {
          id: "attempt",
          workspaceId,
          providerId: input.providerId,
          ownership: input.ownership,
          revision: 1,
          state: "requires_user_action",
          nextAction: { type: "none" },
          credentialsCommitted: false,
          integrationInstalled: false,
          completionRequirement: "connection",
          expiresAt: "2030-01-01T00:00:00Z",
        };
      },
    ),
    "workspace",
  );
  const returnUrl = "https://host.example/done?state=%2f#unchanged";
  const rendered = await renderComponent(
    <ConnectChooser controller={controller} returnUrl={returnUrl} />,
  );
  try {
    expect(
      rendered.container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
    ).toBe(true);
    expect(
      rendered.container.querySelector<HTMLOptionElement>('option[value="disabled"]')!.disabled,
    ).toBe(true);
    await actRun(() => {
      const select = rendered.container.querySelector("select")!;
      select.value = "ready";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      rendered.container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
    ).toBe(true);
    await actRun(() => {
      const select = rendered.container.querySelectorAll("select")[1]!;
      select.value = "personal";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await actRun(() => {
      rendered.container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submitted).toMatchObject({ providerId: "ready", ownership: "personal", returnUrl });
  } finally {
    await rendered.unmount();
    controller.dispose();
  }
});
test("actor replacement ignores old catalog even when transport ignores abort", async () => {
  let finish!: (providers: ConnectProvider[]) => void;
  const previous = new ConnectController(
    transport(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
    "old",
  );
  const current = new ConnectController(
    transport(async () => []),
    "new",
  );
  const rendered = await renderComponent(
    <ConnectChooser controller={previous} returnUrl="https://host.example" />,
  );
  try {
    await rendered.rerender(
      <ConnectChooser controller={current} returnUrl="https://host.example" />,
    );
    await actRun(() => finish([{ ...provider, label: "Old actor private inventory" }]));
    expect(rendered.container.textContent).not.toContain("Old actor");
    expect(rendered.container.textContent).toContain("No connections are available");
  } finally {
    await rendered.unmount();
    previous.dispose();
    current.dispose();
  }
});
