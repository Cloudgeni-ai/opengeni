import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceMember } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterAll(() => GlobalRegistrator.unregister());

const { useMessageSenderRenderer } = await import("./message-senders");

const member = (subjectId: string, subjectLabel: string | null): WorkspaceMember => ({
  subjectId,
  subjectLabel,
  role: "member",
  permissions: [],
  createdAt: "2026-10-10T00:00:00Z",
});

async function senders(
  listWorkspaceMembers: () => Promise<WorkspaceMember[]>,
): Promise<HTMLElement> {
  const client = { listWorkspaceMembers };
  function Probe() {
    const render = useMessageSenderRenderer(client, "ws-1", "user:me");
    const item = { kind: "user-message" } as never;
    return (
      <div>
        <p data-sender="me">{render({ subjectId: "user:me", label: "me@example.test" }, item)}</p>
        <p data-sender="kari">
          {render({ subjectId: "user:kari", label: "kari@example.test" }, item)}
        </p>
        <p data-sender="ola">
          {render({ subjectId: "user:ola", label: "ola@example.test" }, item)}
        </p>
        <p data-sender="unknown">{render({ subjectId: "external:x", label: null }, item)}</p>
      </div>
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => createRoot(container).render(<Probe />));
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  return container;
}

const text = (container: HTMLElement, sender: string) =>
  container.querySelector(`[data-sender="${sender}"]`)?.textContent ?? "";

test("names other people from the workspace's members, never the viewer", async () => {
  const container = await senders(async () => [
    member("user:me", "Me Myself"),
    member("user:kari", "Kari Nordmann"),
  ]);
  expect(text(container, "me")).toBe("");
  expect(text(container, "kari")).toContain("Kari Nordmann");
  // Not a member any more: the label frozen with the message still names them.
  expect(text(container, "ola")).toContain("ola@example.test");
  // Nothing to show for a sender with no identity.
  expect(text(container, "unknown")).toBe("");
});

test("falls back to the frozen label when members can't be read", async () => {
  const container = await senders(async () => {
    throw new Error("forbidden");
  });
  expect(text(container, "kari")).toContain("kari@example.test");
  expect(text(container, "me")).toBe("");
});
