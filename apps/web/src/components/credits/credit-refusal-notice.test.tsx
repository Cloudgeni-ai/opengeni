import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
  }: {
    children: ReactNode;
    to: string;
    params: { workspaceId: string };
    search: { section: string };
  }) => (
    <a href={`${to.replace("$workspaceId", params.workspaceId)}?section=${search.section}`}>
      {children}
    </a>
  ),
}));

const { CreditRefusalNotice } = await import("./credit-refusal-notice");

beforeAll(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    // Another web test in this process already installed Happy DOM.
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const SERVER_MESSAGE =
  "No credits available for this model. Choose a model covered by your promotional credits or add credits.";

async function render(props: Partial<ComponentProps<typeof CreditRefusalNotice>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <CreditRefusalNotice
        gap={{
          modelLabel: "Gemini 4 Argon",
          covered: [
            { id: "azure-sol/gpt-6.1-sol", label: "GPT-6.1 Sol" },
            { id: "gpt-6-luna", label: "GPT-6 Luna" },
          ],
          selectionUsable: false,
        }}
        message={SERVER_MESSAGE}
        workspaceId="ws"
        canBuyCredits
        canConnectModel
        {...props}
      />,
    ),
  );
  return container;
}

test("a refused Send names the model, the reason, what the credit covers, and the next steps", async () => {
  const onChooseModel = mock((_id: string) => undefined);
  const container = await render({ onChooseModel });
  const alert = container.querySelector('[role="alert"]');
  expect(alert).not.toBeNull();
  expect(alert!.textContent).toContain("Your credits don't cover Gemini 4 Argon");
  expect(alert!.textContent).toContain(SERVER_MESSAGE);
  expect(alert!.textContent).toContain("Your credits cover GPT-6.1 Sol and GPT-6 Luna.");
  expect(alert!.textContent).not.toContain("—");
  const use = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Use GPT-6.1 Sol",
  );
  await act(async () => use!.click());
  expect(onChooseModel).toHaveBeenCalledWith("azure-sol/gpt-6.1-sol");
  const links = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
  expect(links).toEqual(["/workspaces/ws/organization?section=billing"]);
});

test("after switching to a model that can run, the notice says to send again", async () => {
  const container = await render({
    gap: {
      modelLabel: "Gemini 4 Argon",
      covered: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }],
      selectionUsable: true,
    },
    onChooseModel: () => undefined,
  });
  expect(container.textContent).toContain("Send again to use the selected model.");
  expect(container.textContent).not.toContain("Use GPT-6 Luna");
});

test("without covered models it offers credits and a connection, and can be dismissed", async () => {
  const onDismiss = mock(() => undefined);
  const container = await render({
    gap: { modelLabel: "Gemini 4 Argon", covered: [], selectionUsable: false },
    onDismiss,
  });
  expect(container.textContent).not.toContain("Your credits cover");
  const links = [...container.querySelectorAll("a")].map((link) => link.textContent);
  expect(links).toEqual(["Buy credits", "Connect a model"]);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click(),
  );
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("people who cannot buy credits are not offered a purchase", async () => {
  const container = await render({ canBuyCredits: false, canConnectModel: false });
  expect(container.querySelectorAll("a")).toHaveLength(0);
  expect(container.textContent).toContain(SERVER_MESSAGE);
});
