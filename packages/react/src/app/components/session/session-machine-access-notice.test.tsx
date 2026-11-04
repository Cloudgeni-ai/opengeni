import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  currentSessionMachineAccess,
  SessionMachineAccessNotice,
} from "./session-machine-access-notice";

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});
const access = {
  sandboxId: "machine",
  machineName: "Build box",
  ownerName: "Alex",
  isOwner: false,
  queuedTurnBlocked: false,
};

async function render(value = access, shared = false) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <SessionMachineAccessNotice
        access={value}
        shared={shared}
        action={<button>Choose machine</button>}
      />,
    ),
  );
}

test("stale pointer and absent server projection never explain a different machine", () => {
  expect(currentSessionMachineAccess(access, "machine")).toBe(access);
  expect(currentSessionMachineAccess(access, "other")).toBeNull();
  expect(currentSessionMachineAccess(access, null)).toBeNull();
  expect(currentSessionMachineAccess(undefined, "machine")).toBeNull();
});

test("pre-send warning identifies owner, machine, draft preservation and both recovery choices", async () => {
  await render();
  expect(container.textContent).toContain("Choose a machine before sending");
  expect(container.textContent).toContain("Alex’s personal machine");
  expect(container.textContent).toContain("Build box");
  expect(container.textContent).toContain("Your draft stays here");
  expect(container.textContent).toContain("Copy request to Alex");
  expect(container.querySelectorAll("button")).toHaveLength(2);
});

test("owner can keep sending without a warning in their own private chat", async () => {
  await render({ ...access, isOwner: true });
  expect(container.textContent).toBe("");
});

test("owner gets a one-line heads-up in a shared chat, with a way to move", async () => {
  await render({ ...access, isOwner: true }, true);
  const headsUp = container.querySelector('[data-testid="own-machine-shared-heads-up"]');
  expect(headsUp?.textContent).toContain(
    "This chat runs on your personal machine “Build box”. People in this workspace see what the agent does on it.",
  );
  expect(container.textContent).not.toContain("Choose a machine before sending");
  expect(container.querySelectorAll("button")).toHaveLength(1);
});

test("other members keep the pre-send warning in a shared chat", async () => {
  await render(access, true);
  expect(container.textContent).toContain("Choose a machine before sending");
  expect(container.querySelector('[data-testid="own-machine-shared-heads-up"]')).toBeNull();
});

test("copy failure displays the request without claiming it was sent", async () => {
  await render();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        throw new Error("clipboard unavailable");
      },
    },
  });
  await act(async () => container.querySelectorAll("button")[1]!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Could you make the machine available to the workspace",
  );
  expect(container.textContent).not.toContain("Request copied");
});
