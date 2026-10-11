import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    { success: mock((_message: string) => undefined), error: mock(() => undefined) },
  ),
}));

mock.module("@/components/ui/destructive-confirm", () => ({
  DestructiveConfirm: ({
    open,
    title,
    consequences,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    consequences: ReactNode[];
    confirmLabel: string;
    onConfirm: () => unknown;
  }) =>
    open ? (
      <div data-testid="confirm">
        <span>{title}</span>
        {consequences.map((each) => (
          <span key={String(each)}>{each}</span>
        ))}
        <button type="button" onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { PersonalApiKeys, CreatePersonalApiKeyPage } = await import("./personal-api-keys");
type Key = import("./personal-api-keys").PersonalApiKey;

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const me = "user:11111111-1111-4111-8111-111111111111";
const timestamp = "2026-09-01T10:00:00.000Z";
const workspaces = [
  { id: "33333333-3333-4333-8333-333333333333", name: "Design", personal: false },
];
function key(overrides: Partial<Key>): Key {
  return {
    id: crypto.randomUUID(),
    organizationId: "22222222-2222-4222-8222-222222222222",
    name: "Laptop scripts",
    description: null,
    prefix: "ogp_a8ad85a4dc",
    access: {
      preset: "read_only",
      permissions: ["workspace:read"],
      workspaceScope: { kind: "all" },
    },
    owner: { subjectId: me, name: "Ola Nordmann" },
    expiresAt: null,
    lastUsedAt: null,
    createdAt: timestamp,
    ...overrides,
  } as Key;
}

function menuButton(root: ParentNode, name: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`button[aria-label="More actions for ${name}"]`);
}

async function chooseRevoke(root: ParentNode, name: string) {
  const trigger = menuButton(root, name);
  if (!trigger) throw new Error(`Missing menu for ${name}`);
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flush();
  const item = Array.from(document.querySelectorAll("[role=menuitem]")).find(
    (candidate) => candidate.textContent?.trim() === "Revoke key…",
  );
  if (!(item instanceof HTMLElement)) throw new Error("Missing Revoke key… item");
  await act(async () => item.click());
  await flush();
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const match = Array.from(root.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return match;
}

function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    mount: async () => {
      await act(async () => root.render(node));
      await flush();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("personal API keys", () => {
  test("an empty list explains what a personal key is and offers to create one", async () => {
    const navigate = mock((_next: unknown) => undefined);
    const view = render(
      <PersonalApiKeys
        organizationName="Acme"
        api={{
          list: async () => ({ apiKeys: [], canManageAll: false }),
          create: async () => {
            throw new Error("unused");
          },
          revoke: async () => undefined,
        }}
        currentSubjectId={me}
        workspaces={workspaces}
        location={{}}
        onNavigate={navigate}
      />,
    );
    await view.mount();
    expect(view.container.textContent).toContain("No personal keys yet");
    expect(view.container.textContent).toContain("works as you in Acme");
    await act(async () => button(view.container, "Create personal key").click());
    expect(navigate).toHaveBeenCalledWith({ view: "new-personal-key" });
    await view.unmount();
  });

  test("a member revokes only their own keys; an admin sees and revokes everyone's", async () => {
    const mine = key({ name: "Laptop scripts" });
    const theirs = key({
      name: "Release bot",
      prefix: "ogp_ffee001122",
      owner: { subjectId: "user:other", name: "Maja Berg" },
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const revoke = mock(async (_id: string) => undefined);
    const member = render(
      <PersonalApiKeys
        organizationName="Acme"
        api={{
          list: async () => ({ apiKeys: [mine, theirs], canManageAll: false }),
          create: async () => {
            throw new Error("unused");
          },
          revoke,
        }}
        currentSubjectId={me}
        workspaces={workspaces}
        location={{}}
        onNavigate={() => undefined}
      />,
    );
    await member.mount();
    const text = member.container.textContent ?? "";
    expect(text).toContain("Keys that work as you.");
    expect(text).toContain("Maja Berg · Read only");
    expect(text).not.toContain("All workspaces");
    expect(text).not.toContain("Ola Nordmann");
    expect(text).toContain("Expired");
    expect(menuButton(member.container, "Release bot")).toBeNull();
    await chooseRevoke(member.container, "Laptop scripts");
    const confirm = member.container.querySelector("[data-testid=confirm]")!;
    expect(confirm.textContent).toContain(
      "Every request using ogp_a8ad85a4dc… is refused right away.",
    );
    expect(confirm.textContent).toContain("This can't be undone.");
    await act(async () => button(confirm, "Revoke key").click());
    await flush();
    expect(revoke).toHaveBeenCalledWith(mine.id);
    await member.unmount();

    const admin = render(
      <PersonalApiKeys
        organizationName="Acme"
        api={{
          list: async () => ({ apiKeys: [mine, theirs], canManageAll: true }),
          create: async () => {
            throw new Error("unused");
          },
          revoke,
        }}
        currentSubjectId={me}
        workspaces={workspaces}
        location={{}}
        onNavigate={() => undefined}
      />,
    );
    await admin.mount();
    expect(admin.container.textContent).toContain("Owners and admins see everyone's.");
    await chooseRevoke(admin.container, "Release bot");
    expect(admin.container.querySelector("[data-testid=confirm]")!.textContent).toContain(
      "Maja Berg will need to create a new key.",
    );
    await admin.unmount();
  });

  test("creating sends full access for 90 days by default and shows the key once", async () => {
    const onCreate = mock(async (_request: unknown) => "ogp_secret_value");
    const close = mock(() => undefined);
    const view = render(
      <CreatePersonalApiKeyPage
        organizationName="Acme"
        workspaces={workspaces}
        onCreate={onCreate}
        onClose={close}
      />,
    );
    await view.mount();
    expect(view.container.textContent).toContain("works as you in Acme");
    const before = Date.now();
    await act(async () => button(view.container, "Create key").click());
    await flush();
    const request = onCreate.mock.calls[0]![0] as {
      name: string;
      access: { preset: string; permissions: string[]; workspaceScope: { kind: string } };
      expiresAt: string;
    };
    expect(request.name).toBe("My automation");
    expect(request.access.preset).toBe("full");
    expect(request.access.permissions.length).toBeGreaterThan(10);
    expect(request.access.workspaceScope).toEqual({ kind: "all" });
    const days = (Date.parse(request.expiresAt) - before) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    expect(view.container.textContent).toContain("Personal key created");
    expect(view.container.innerHTML).toContain("ogp_secret_value");
    expect(view.container.textContent).toContain("keep it as private as your password");
    await act(async () => button(view.container, "I've saved it").click());
    await flush();
    expect(close).toHaveBeenCalled();
    await view.unmount();
  });
});
