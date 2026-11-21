import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

GlobalRegistrator.register({ url: "https://example.test" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let agentsRead: () => Promise<unknown[]> = async () => [];
const context = {
  client: {
    listAgents: () => agentsRead(),
    listArtifactCatalog: async () => ({ items: [] }),
  },
};
mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => context,
  useOptionalAppContext: () => context,
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AddForm, RenameField } = await import("./sidebar-customize");

afterAll(() => GlobalRegistrator.unregister());

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
    await flush();
  });
  return container;
}

function renameField() {
  const saves: string[] = [];
  let done = 0;
  return {
    saves,
    done: () => done,
    node: (
      <RenameField
        label="Releases"
        onSave={(label) => saves.push(label)}
        onDone={() => {
          done += 1;
        }}
      />
    ),
  };
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(input: HTMLInputElement, name: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

test("rename: Enter saves the new name once, even with the blur that follows", async () => {
  const field = renameField();
  const container = await render(field.node);
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Group name']")!;
  await act(async () => flush());
  expect(document.activeElement === input).toBe(true);
  await type(input, "  Weekly releases ");
  await key(input, "Enter");
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(field.saves).toEqual(["Weekly releases"]);
  expect(field.done()).toBe(1);
});

test("rename: Escape cancels without saving", async () => {
  const field = renameField();
  const container = await render(field.node);
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Group name']")!;
  await type(input, "Something else");
  await key(input, "Escape");
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(field.saves).toEqual([]);
  expect(field.done()).toBe(1);
});

test("rename: leaving the field saves", async () => {
  const field = renameField();
  const container = await render(field.node);
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Group name']")!;
  await type(input, "Ship");
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(field.saves).toEqual(["Ship"]);
  expect(field.done()).toBe(1);
});

test("rename: a blank or unchanged name keeps the old one", async () => {
  const blank = renameField();
  const container = await render(blank.node);
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Group name']")!;
  await type(input, "   ");
  await key(input, "Enter");
  expect(blank.saves).toEqual([]);
  expect(blank.done()).toBe(1);
  await act(async () => root!.unmount());
  root = null;

  const same = renameField();
  const again = await render(same.node);
  await key(again.querySelector<HTMLInputElement>("input[aria-label='Group name']")!, "Enter");
  expect(same.saves).toEqual([]);
  expect(same.done()).toBe(1);
});

test("adding an agent says when the agents can't be read, and tries again", async () => {
  let reads = 0;
  agentsRead = async () => {
    reads += 1;
    throw Object.assign(new Error("Opengeni API 500: down"), { status: 500 });
  };
  const container = await render(
    <AddForm
      kind="agent"
      workspaceId="workspace-1"
      groups={[]}
      onAdd={async () => undefined}
      onCancel={() => undefined}
    />,
  );
  expect(container.textContent).toContain("Couldn't load agents.");
  expect(reads).toBe(1);
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  )!;
  agentsRead = async () => [];
  await act(async () => {
    retry.click();
    await flush();
  });
  expect(container.textContent).not.toContain("Couldn't load agents.");
});
