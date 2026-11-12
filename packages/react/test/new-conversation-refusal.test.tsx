// A brand-new chat whose creation is refused says why and keeps the draft, so
// the person can change model, speed or effort and send again. A creation whose
// outcome is unknown keeps the safe exact-retry state instead.
import { expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";
import type { ReactNode } from "react";
import { NewConversationView } from "../src/components/new-conversation";
import {
  useNewConversation,
  type NewConversationController,
  type UseNewConversationOptions,
} from "../src/hooks/use-new-conversation";
import { ErrorMessageContext, type ErrorMessageFormatter } from "../src/lib/error-message";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const REASON = "Ultrafast isn't available for this model. Choose another speed.";

/** A host endpoint's refusal, wrapped the way host adapters hand it to the stock new chat. */
function hostRefusal(status = 400) {
  return new OpenGeniApiError(
    status,
    JSON.stringify({
      error: REASON,
      code: "BAD_REQUEST",
      details: { field: "latencyMode" },
    }),
    { outcomeUnknown: false },
  );
}

function client() {
  const base = fakeClient({});
  return fakeClient({
    getClientConfig: async () => ({ ...(await base.getClientConfig()) }) as never,
    getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
  });
}

async function renderNewChat(
  createSession: NonNullable<UseNewConversationOptions["createSession"]>,
  formatError?: ErrorMessageFormatter,
) {
  const holder: { current: NewConversationController | null } = { current: null };
  const api = client();
  function Harness() {
    const creation = useNewConversation({
      client: api,
      workspaceId: WORKSPACE_ID,
      createSession,
    });
    holder.current = creation;
    return <NewConversationView creation={creation} />;
  }
  const tree: ReactNode = formatError ? (
    <ErrorMessageContext.Provider value={formatError}>
      <Harness />
    </ErrorMessageContext.Provider>
  ) : (
    <Harness />
  );
  const view = await renderComponent(tree);
  await flush(20);
  const controller = () => holder.current!;
  const alert = () => view.container.querySelector('[role="alert"]')?.textContent ?? null;
  const input = () => view.container.querySelector("textarea")!;
  const sendButton = () =>
    view.container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  return { view, controller, alert, input, sendButton };
}

test("a definite create refusal shows its own reason and keeps a usable composer with the draft", async () => {
  const keys: string[] = [];
  const chat = await renderNewChat(async (_text, key) => {
    keys.push(key);
    if (keys.length === 1) throw hostRefusal();
    return "created-id";
  });
  try {
    await actRun(() => chat.controller().composer.setValue("Plan the week"));
    expect(await actRun(() => chat.controller().composer.send())).toBe(false);

    expect(chat.alert()).toBe(REASON);
    expect(chat.view.container.textContent).not.toContain("Check your input");
    expect(chat.controller().pending).toBeNull();
    expect(chat.view.container.querySelector('[role="status"]')).toBeNull();
    expect(chat.input().value).toBe("Plan the week");
    expect(chat.input().disabled).toBe(false);
    expect(chat.sendButton().disabled).toBe(false);

    // Changing the speed is the fix the refusal asks for; the stale reason goes.
    await actRun(() => chat.controller().composer.setLatencyMode!("standard"));
    expect(chat.alert()).toBeNull();
    expect(await actRun(() => chat.controller().composer.send())).toBe(true);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  } finally {
    await chat.view.unmount();
  }
});

test("a host formatter receives the refusal's reason as the default copy", async () => {
  const seen: string[] = [];
  const chat = await renderNewChat(
    async () => {
      throw hostRefusal(422);
    },
    (_error, message) => {
      seen.push(message);
      return undefined;
    },
  );
  try {
    await actRun(() => chat.controller().composer.setValue("Plan the week"));
    await actRun(() => chat.controller().composer.send());
    expect(seen.at(-1)).toBe(REASON);
    expect(chat.alert()).toBe(REASON);
  } finally {
    await chat.view.unmount();
  }
});

test("an ambiguous create failure keeps the exact-retry state and blocks a second create", async () => {
  for (const failure of [
    new TypeError("Failed to fetch"),
    new OpenGeniApiError(503, "", { outcomeUnknown: true }),
  ]) {
    let calls = 0;
    const chat = await renderNewChat(async () => {
      calls++;
      throw failure;
    });
    try {
      await actRun(() => chat.controller().composer.setValue("Plan the week"));
      expect(await actRun(() => chat.controller().composer.send())).toBe(false);
      expect(chat.controller().pending).not.toBeNull();
      expect(chat.alert()).not.toContain(REASON);
      const status = chat.view.container.querySelector('[role="status"]')?.textContent;
      expect(status).toBeTruthy();
      expect(chat.view.container.textContent).toContain("Retry");
      expect(chat.input().value).toBe("Plan the week");
      expect(chat.sendButton().disabled).toBe(true);
      expect(await actRun(() => chat.controller().composer.send())).toBe(false);
      expect(calls).toBe(1);
    } finally {
      await chat.view.unmount();
    }
  }
});
