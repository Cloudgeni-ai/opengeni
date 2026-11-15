import "@/app-host";
import type { ChatClient, OrganizationAnthropicApiKey } from "@opengeni/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useConsoleSharedQueries } from "@opengeni/react/app/lib/shared-query";

// The dialog renders its real form frame inline: the Radix dialog around it is a portal.
const actualFormDialog = await import("@opengeni/react/ui/form-dialog");
mock.module("@opengeni/react/ui/form-dialog", () => ({
  ...actualFormDialog,
  FormDialog: ({
    open,
    onOpenChange,
    size: _size,
    trigger: _trigger,
    ...frame
  }: Parameters<typeof actualFormDialog.FormDialog>[0]) =>
    open ? (
      <div role="dialog">
        <actualFormDialog.FormFrame
          variant="inline"
          {...frame}
          onCancel={() => onOpenChange?.(false)}
        />
      </div>
    ) : null,
}));
const { OrganizationAnthropicApiKeys } = await import("./organization-anthropic-api-keys");

/* ----------------------------------------------------------------------------
   MP-KEYS-13: the organization Anthropic API connection's keys: each key's
   state, letting a key out of credits serve again, and adding a key, against
   a mocked client. Key values are never shown.
   -------------------------------------------------------------------------- */

const connectionKey: OrganizationAnthropicApiKey = {
  id: "primary-v1",
  label: null,
  connectionKey: true,
  anthropicOrganizationId: null,
  creditRefusedAt: null,
  createdAt: "2026-11-12T00:00:00.000Z",
};
const refused: OrganizationAnthropicApiKey = {
  id: "00000000-0000-4000-8000-0000000000a2",
  label: "Second account",
  connectionKey: false,
  anthropicOrganizationId: "org-second",
  creditRefusedAt: "2026-11-12T01:00:00.000Z",
  createdAt: "2026-11-12T00:00:00.000Z",
};

let calls: unknown[][] = [];
let client: ChatClient<OpenGeniBrowserClient>;

function freshClient(): ChatClient<OpenGeniBrowserClient> {
  let keys = [connectionKey, refused];
  calls = [];
  return {
    listOrganizationAnthropicApiKeys: async () => ({ connectionVersion: 1, keys }),
    serveOrganizationAnthropicApiKeyAgain: async (organizationId: string, keyId: string) => {
      calls.push(["serveAgain", organizationId, keyId]);
      keys = keys.map((key) => (key.id === keyId ? { ...key, creditRefusedAt: null } : key));
      return keys.find((key) => key.id === keyId);
    },
    updateOrganizationAnthropicApiKey: async (
      organizationId: string,
      keyId: string,
      request: { label: string },
    ) => {
      calls.push(["rename", organizationId, keyId, request]);
      keys = keys.map((key) => (key.id === keyId ? { ...key, label: request.label } : key));
      return keys.find((key) => key.id === keyId);
    },
    addOrganizationAnthropicApiKey: async (
      organizationId: string,
      request: { apiKey: string; label: string },
    ) => {
      calls.push(["add", organizationId, request]);
      const added = {
        ...refused,
        id: "00000000-0000-4000-8000-0000000000a3",
        label: request.label,
        creditRefusedAt: null,
      };
      keys = [...keys, added];
      return added;
    },
  } as unknown as ChatClient<OpenGeniBrowserClient>;
}

function Harness() {
  useConsoleSharedQueries(client);
  return <OrganizationAnthropicApiKeys client={client} organizationId="org-a" canManage />;
}

let root: Root, container: HTMLDivElement;
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  client = freshClient();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => GlobalRegistrator.unregister());

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await act(async () => await Bun.sleep(10));
};

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

async function enter(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const props = (
      input as unknown as Record<
        string,
        { onChange?: (event: { target: HTMLInputElement }) => void }
      >
    )[reactPropsKey!]!;
    props.onChange!({ target: input });
  });
}

test("MP-KEYS-13: each key shows whether it serves; one out of credits can serve again", async () => {
  await act(async () => root.render(<Harness />));
  await settle();
  const rows = [...container.querySelectorAll("[role=listitem]")].map((row) => row.textContent);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("Connection key");
  expect(rows[0]).toContain("Serving");
  expect(rows[1]).toContain("Second account");
  expect(rows[1]).toContain("Out of credits");
  expect(rows[1]).toContain("org-second");
  // The connection's own key is removed with the connection, not here.
  expect(() => button("Remove Connection key")).toThrow();
  await act(async () => button("Serve again").click());
  await settle();
  expect(calls).toEqual([["serveAgain", "org-a", refused.id]]);
  expect(container.textContent).not.toContain("Out of credits");
});

test("MP-KEYS-13: adding a key sends its name and value once", async () => {
  await act(async () => root.render(<Harness />));
  await settle();
  await act(async () => button("Add API key").click());
  await settle();
  await enter(document.querySelector("input[aria-label='Key name']")!, " Third account ");
  await enter(
    document.querySelector("input[aria-label='Anthropic API key']")!,
    "sk-ant-api03-third",
  );
  await act(async () => button("Add key").click());
  await settle();
  expect(calls).toEqual([
    ["add", "org-a", { apiKey: "sk-ant-api03-third", label: "Third account" }],
  ]);
  expect(container.querySelectorAll("[role=listitem]")).toHaveLength(3);
  expect(container.textContent).not.toContain("sk-ant-api03-third");
});

test("MP-KEYS-13: an added key is renamed; the connection's own key has no name to change", async () => {
  await act(async () => root.render(<Harness />));
  await settle();
  expect(() => button("Rename Connection key")).toThrow();
  await act(async () => button("Rename Second account").click());
  await settle();
  await enter(document.querySelector("input[aria-label='New key name']")!, " Renamed ");
  await act(async () => button("Save name").click());
  await settle();
  expect(calls).toEqual([["rename", "org-a", refused.id, { label: "Renamed" }]]);
  expect(container.querySelectorAll("[role=listitem]")[1]?.textContent).toContain("Renamed");
});
