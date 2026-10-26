import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("../../lib/navigation", () => ({
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

let balanceMicros = 0;
const getBilling = mock(async (_input: { accountId: string }) => ({
  mode: "stripe" as const,
  balance: { balanceMicros },
}));
const appContext = { client: { getBilling } };
mock.module("../../app-context", () => ({ useAppContext: () => appContext }));

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
  balanceMicros = 0;
  getBilling.mockClear();
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
  // Let the balance read settle.
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
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
  expect(links).toEqual(["Add credits", "Use your own provider account"]);
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

test("with no credit for any model it says so plainly, not the promotional-credit advice", async () => {
  const gap = { modelLabel: "Assistant", covered: [], selectionUsable: false };
  const billing = { accountId: "org", canReadBilling: true };
  const container = await render({ gap, ...billing });
  expect(getBilling).toHaveBeenCalledWith({ accountId: "org" });
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Add credits to start chatting");
  expect(alert.textContent).toContain(
    "Chats here are paid with Opengeni credits, and you don't have any right now.",
  );
  expect(alert.textContent).not.toContain("don't cover");
  expect(alert.textContent).not.toContain("promotional");
  await act(async () => root!.unmount());
  const inChat = await render({ gap, ...billing, continuing: true });
  expect(inChat.textContent).toContain("Add credits to keep chatting");
  await act(async () => root!.unmount());
  const member = await render({ gap, ...billing, canBuyCredits: false });
  expect(member.textContent).toContain("No credits left");
  expect(member.textContent).toContain("Ask an organization owner to add some.");
});

test("credit that covers no model gets the new-chat page's words, not \"you don't have any\"", async () => {
  balanceMicros = 5_500_000;
  const gap = { modelLabel: "Assistant", covered: [], selectionUsable: false };
  const billing = { accountId: "org", canReadBilling: true };
  const container = await render({ gap, ...billing, continuing: true });
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Add credits to use this model");
  expect(alert.textContent).toContain(
    "This model can't use the Opengeni credits you have right now. Add credits, or choose another model.",
  );
  expect(alert.textContent).not.toContain("don't have any");
  expect(alert.textContent).not.toContain("promotional");
  await act(async () => root!.unmount());
  const member = await render({ gap, ...billing, canBuyCredits: false });
  expect(member.textContent).toContain("Credits needed for this model");
  expect(member.textContent).toContain(
    "This model can't use your organization's Opengeni credits right now.",
  );
  expect(member.textContent).not.toContain("No credits left");
});

test("without the balance it claims neither state", async () => {
  const gap = { modelLabel: "Assistant", covered: [], selectionUsable: false };
  const container = await render({ gap, accountId: "org", canReadBilling: false });
  expect(getBilling).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Add credits to use this model");
  expect(container.textContent).toContain("This model needs Opengeni credits.");
  expect(container.textContent).not.toContain("don't have any");
  expect(container.textContent).not.toContain("you have right now");
});

test("the refusal shows the server's sentence, not the SDK's status prefix or reference", async () => {
  // OpenGeniApiError.message for a 402 from the API, as the routes pass it.
  const container = await render({
    message: `API 402: ${SERVER_MESSAGE} Reference: 9f1c2b7e-4d1a-4c55-9a0e-3b8f2d6c1a47.`,
  });
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain(SERVER_MESSAGE);
  expect(alert.textContent).not.toContain("API 402");
  expect(alert.textContent).not.toContain("Reference");
});
