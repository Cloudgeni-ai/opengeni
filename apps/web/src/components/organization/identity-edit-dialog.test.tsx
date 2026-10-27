import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError } from "@opengeni/sdk";
import type { CompanyProfileContent, CompanyProfileHead } from "@opengeni/sdk";

// Register the DOM before React DOM loads, so typing reaches onChange.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const SonnerPackage = await import("sonner");
const ContextModule = await import("@opengeni/react/app/app-context");
const FormDialogModule = await import("@opengeni/react/ui/form-dialog");

const workspaceId = "workspace-identity";
const toastSuccess = mock((_message: string) => undefined);
const updateCompanyProfile = mock(
  async (_workspaceId: string, _request: unknown): Promise<unknown> => ({
    revision: null,
    head: null,
    event: null,
  }),
);

mock.module("@opengeni/react/app/app-context", () => ({
  ...ContextModule,
  useAppContext: () => ({ client: { updateCompanyProfile } }),
}));
mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    { success: toastSuccess, error: mock((_message: string) => undefined) },
  ),
}));
// Keep the test independent of Radix portal mounting: the same form frame,
// rendered in place while open.
mock.module("@opengeni/react/ui/form-dialog", () => ({
  ...FormDialogModule,
  FormDialog: ({
    open,
    onOpenChange,
    onSubmitted,
    size: _size,
    ...frame
  }: Parameters<typeof FormDialogModule.FormDialog>[0]) =>
    open ? (
      <div role="dialog">
        <FormDialogModule.FormFrame
          variant="dialog"
          {...frame}
          onSubmitted={() => {
            onSubmitted?.();
            onOpenChange(false);
          }}
        />
      </div>
    ) : null,
}));

const { EditIdentityDialog } = await import("./identity-page");

const head: CompanyProfileHead = {
  accountId: "account-identity",
  revisionId: "00000000-0000-4000-8000-000000000007",
  revision: 3,
  contentHash: "a".repeat(64),
  activationVersion: 4,
  activatedAt: "2026-08-20T10:00:00.000Z",
};
const products = [{ key: "app", content: "An app for bakeries." }];
const profile: CompanyProfileContent = {
  identity: "A small bakery tools team.",
  mission: "Local bakeries should thrive.",
  products,
  customers: [],
  goals: [],
  constraints: [],
};

const mounted: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const unmount of mounted.splice(0)) await unmount();
  updateCompanyProfile.mockReset();
  updateCompanyProfile.mockImplementation(async () => ({
    revision: null,
    head: null,
    event: null,
  }));
  toastSuccess.mockClear();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return match;
}

async function settle() {
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function textarea(name: string): HTMLTextAreaElement {
  const found = document.querySelector<HTMLTextAreaElement>(`textarea[name="${name}"]`);
  if (!found) throw new Error(`Missing field: ${name}`);
  return found;
}

async function type(field: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function save() {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(button(dialog, "Save").disabled).toBe(false);
  await act(async () => {
    dialog.querySelector("form")!.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
}

async function openEditor(options: {
  profile: CompanyProfileContent | null;
  head: CompanyProfileHead | null;
}) {
  const onSaved = mock(async () => undefined);
  const onOpenChange = mock((_open: boolean) => undefined);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <EditIdentityDialog
        open
        onOpenChange={onOpenChange}
        workspaceId={workspaceId}
        profile={options.profile}
        head={options.head}
        onSaved={onSaved}
      />,
    );
  });
  await settle();
  return { onSaved, onOpenChange };
}

describe("an owner writes the organization identity by hand", () => {
  test("starts from the current text and waits for a change before saving", async () => {
    await openEditor({ profile, head });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Edit identity and mission");
    expect(textarea("organization-identity").value).toBe("A small bakery tools team.");
    expect(textarea("organization-mission").value).toBe("Local bakeries should thrive.");
    expect(button(dialog, "Save").disabled).toBe(true);
  });

  test("saves the two fields against the current revision and keeps the older details", async () => {
    const { onSaved, onOpenChange } = await openEditor({ profile, head });
    await type(textarea("organization-identity"), "  A bakery tools team in Bergen.  ");
    await save();

    expect(updateCompanyProfile).toHaveBeenCalledTimes(1);
    const [calledWorkspace, request] = updateCompanyProfile.mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(calledWorkspace).toBe(workspaceId);
    expect(request).toMatchObject({
      profile: {
        identity: "A bakery tools team in Bergen.",
        mission: "Local bakeries should thrive.",
        products,
        customers: [],
        goals: [],
        constraints: [],
      },
      expectedCurrentRevisionId: head.revisionId,
      expectedActivationVersion: head.activationVersion,
      reason: "Edited in organization settings",
    });
    expect(typeof request.operationId).toBe("string");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith("Saved. New chats use the updated identity.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("writes the first identity when none exists yet", async () => {
    await openEditor({ profile: null, head: null });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Write identity and mission");
    expect(button(dialog, "Save").disabled).toBe(true);
    await type(textarea("organization-mission"), "Local bakeries should thrive.");
    await save();

    const [, request] = updateCompanyProfile.mock.calls[0]! as [string, Record<string, unknown>];
    expect(request).toMatchObject({
      profile: {
        identity: null,
        mission: "Local bakeries should thrive.",
        products: [],
        customers: [],
        goals: [],
        constraints: [],
      },
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
    });
  });

  test("a conflicting save keeps the text, explains, and reloads the newer version", async () => {
    const { onSaved, onOpenChange } = await openEditor({ profile, head });
    updateCompanyProfile.mockImplementation(async () => {
      throw new OpenGeniApiError(409, "company profile head changed", {});
    });
    await type(textarea("organization-identity"), "A bakery tools team in Bergen.");
    await save();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("The identity changed while you were editing.");
    expect(dialog!.textContent).not.toContain("409");
    expect(textarea("organization-identity").value).toBe("A bakery tools team in Bergen.");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test("retrying the same text after an unclear outcome reuses the operation", async () => {
    await openEditor({ profile, head });
    updateCompanyProfile.mockImplementation(async () => {
      throw new Error("Network error");
    });
    await type(textarea("organization-identity"), "A bakery tools team in Bergen.");
    await save();
    await save();
    await type(textarea("organization-identity"), "A bakery tools team in Oslo.");
    await save();

    const ids = updateCompanyProfile.mock.calls.map(
      ([, request]) => (request as { operationId: string }).operationId,
    );
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(ids[1]);
    // Different text is a different save.
    expect(ids[2]).not.toBe(ids[0]);
  });

  test("a field over the limit says so and blocks Save", async () => {
    await openEditor({ profile, head });
    await type(textarea("organization-identity"), "x".repeat(2049));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Keep it under");
    expect(button(dialog, "Save").disabled).toBe(true);
  });
});
