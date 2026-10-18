import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OpenGeniApiError, type ProviderVaultMeta } from "@opengeni/sdk";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { VaultChooser } = await import("./vault-chooser");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { buildMockState } = await import("@/dev/secrets-mock/fixtures");
const { vaultError } = await import("./vault-model");
const fixture = buildMockState("managed-test");
const linked = {
  ...fixture.vaults.find((vault) => vault.source === "onepassword")!,
  name: "Opengeni",
};
const meta: ProviderVaultMeta = {
  externalVaultId: "created-external",
  name: "Opengeni",
  itemCount: 0,
  linkedVaultId: null,
};
const createManaged = mock(async () => linked);
const refreshVaults = mock(async (): Promise<ProviderVaultMeta[]> => [meta]);
const link = mock(async () => linked);
const openVault = mock(() => undefined);
const onLinked = mock(() => undefined);
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  createManaged.mockReset().mockImplementation(async () => linked);
  refreshVaults.mockReset().mockImplementation(async () => [meta]);
  link.mockClear();
  openVault.mockClear();
  onLinked.mockClear();
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});
afterAll(() => GlobalRegistrator.unregister());

function fail(code: string, details: Record<string, unknown> = {}) {
  return vaultError(
    new OpenGeniApiError(
      503,
      JSON.stringify({
        error: code,
        message: "Managed vault outcome",
        details,
      }),
      { mutation: true },
    ),
    undefined,
    "1Password",
  );
}
function button(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === name,
  );
}
async function setup(linkedVaults = [linked]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <VaultChooser
          provider="onepassword"
          title="Choose vaults"
          description="Choose what agents use."
          providerVaults={[]}
          linkedVaults={linkedVaults}
          owner="workspace"
          connectionId="connection"
          canCreateManaged
          cancelLabel="Cancel"
          onClose={() => undefined}
          onLinked={onLinked}
          actions={{ createManaged, refreshVaults, link, openVault }}
        />
      </TooltipProvider>,
    ),
  );
  await act(async () => button("Create managed vault")!.click());
  const form = document.querySelector('[role="dialog"] form')!;
  expect(form).not.toBeNull();
  return async () =>
    act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

for (const scenario of ["sharing", "sync", "unlinked", "unknown-link"] as const) {
  test(`confirmed managed creation: ${scenario} closes create and refreshes without replay`, async () => {
    const confirmedLinked = scenario === "sharing" || scenario === "sync";
    createManaged.mockImplementation(async () => {
      throw fail("provider_unavailable", {
        created: true,
        linked: confirmedLinked ? true : scenario === "unlinked" ? false : null,
        connectionId: "connection",
        externalVaultId: meta.externalVaultId,
        ...(confirmedLinked ? { vaultId: linked.id } : {}),
        ...(scenario === "sharing" ? { groupGrantConfirmed: false } : {}),
      });
    });
    refreshVaults.mockImplementation(async () => [
      { ...meta, ...(confirmedLinked ? { linkedVaultId: linked.id } : {}) },
    ]);
    const submit = await setup();
    await submit();
    await submit();
    expect(createManaged).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button("Create vault")).toBeUndefined();
    expect(button("Create managed vault")).toBeUndefined();
    expect(refreshVaults).toHaveBeenCalledWith("connection");
    expect(host.textContent).toContain("Created Opengeni in 1Password");
    expect(host.textContent).toContain("Don't create it again.");
    expect(onLinked).not.toHaveBeenCalled();
    if (scenario === "sharing") expect(host.textContent).toContain("Check sharing in 1Password");
    if (confirmedLinked) {
      await act(async () => button("Open vault")!.click());
      expect(openVault).toHaveBeenCalledWith({ id: linked.id });
      expect(link).not.toHaveBeenCalled();
    } else {
      expect(button("Link 1 vault")).toBeDefined();
      await act(async () => button("Link 1 vault")!.click());
      expect(link).toHaveBeenCalledWith(
        meta,
        "read_write",
        "workspace",
        "connection",
        "onepassword",
      );
      expect(createManaged).toHaveBeenCalledTimes(1);
    }
  });
}

test("unknown local acknowledgement reconciles to an existing link, not another Link", async () => {
  createManaged.mockImplementation(async () => {
    throw fail("provider_unavailable", {
      created: true,
      linked: null,
      externalVaultId: meta.externalVaultId,
    });
  });
  refreshVaults.mockImplementation(async () => [{ ...meta, linkedVaultId: linked.id }]);
  const submit = await setup();
  await submit();
  expect(button("Link 1 vault")).toBeUndefined();
  await act(async () => button("Open vault")!.click());
  expect(openVault).toHaveBeenCalledWith({ id: linked.id });
  expect(link).not.toHaveBeenCalled();
});

test("failed reconciliation retries only reads and retains the confirmed creation", async () => {
  createManaged.mockImplementation(async () => {
    throw fail("vault_name_conflict", {
      created: true,
      linked: false,
      externalVaultId: meta.externalVaultId,
    });
  });
  refreshVaults.mockRejectedValueOnce(fail("provider_unavailable"));
  const submit = await setup();
  await submit();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toContain("Don't create it again.");
  expect(host.textContent).toContain("name");
  await act(async () => button("Check again")!.click());
  expect(refreshVaults).toHaveBeenCalledTimes(2);
  expect(createManaged).toHaveBeenCalledTimes(1);
  expect(button("Link 1 vault")).toBeDefined();
});

for (const code of ["vault_name_conflict", "vault_permission_denied", "provider_outcome_unknown"]) {
  test(`${code} without created confirmation remains an ordinary failure`, async () => {
    createManaged.mockImplementation(async () => {
      throw fail(code);
    });
    const submit = await setup();
    await submit();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button("Create vault")!.disabled).toBe(false);
    if (code === "provider_outcome_unknown")
      expect(document.body.textContent).toContain("Check there before you try again");
    await submit();
    expect(createManaged).toHaveBeenCalledTimes(2);
    expect(refreshVaults).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
  });
}

test("ordinary successful creation still closes and adds the managed vault", async () => {
  const submit = await setup();
  await submit();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toContain("Created · Read & write");
  expect(createManaged).toHaveBeenCalledTimes(1);
  expect(onLinked).not.toHaveBeenCalled();
});

test("Done after a confirmed link opens it instead of reporting no linked vaults", async () => {
  createManaged.mockImplementation(async () => {
    throw fail("provider_unavailable", {
      created: true,
      linked: true,
      vaultId: linked.id,
      externalVaultId: meta.externalVaultId,
    });
  });
  // A stale provider row must never become another Link action either.
  const submit = await setup();
  await submit();
  expect(button("Link 1 vault")).toBeUndefined();
  await act(async () => button("Done")!.click());
  expect(openVault).toHaveBeenCalledWith({ id: linked.id });
  expect(onLinked).not.toHaveBeenCalled();
});

test("a confirmed link opens before its local summary arrives without opening unrelated rows", async () => {
  createManaged.mockImplementation(async () => {
    throw fail("provider_unavailable", {
      created: true,
      linked: true,
      vaultId: linked.id,
      externalVaultId: meta.externalVaultId,
    });
  });
  refreshVaults.mockImplementation(async () => [
    { ...meta, linkedVaultId: linked.id },
    { ...meta, externalVaultId: "unrelated", name: "Unrelated", linkedVaultId: "unrelated-local" },
  ]);
  const submit = await setup([]);
  await submit();
  const rows = [...host.querySelectorAll("li")];
  const createdRow = rows.find((row) => row.textContent?.includes("Opengeni"))!;
  const unrelatedRow = rows.find((row) => row.textContent?.includes("Unrelated"))!;
  expect(unrelatedRow.querySelector("button")).toBeNull();
  await act(async () => createdRow.querySelector("button")!.click());
  expect(openVault).toHaveBeenCalledWith({ id: linked.id });
  expect(link).not.toHaveBeenCalled();
});

test("slow listing never keeps a confirmed create form open", async () => {
  let finish!: (value: ProviderVaultMeta[]) => void;
  refreshVaults.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  createManaged.mockImplementation(async () => {
    throw fail("provider_unavailable", {
      created: true,
      linked: null,
      externalVaultId: meta.externalVaultId,
    });
  });
  const submit = await setup();
  await submit();
  await submit();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(createManaged).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Its link wasn't confirmed.");
  expect(button("Checking…")!.disabled).toBe(true);
  await act(async () => finish([meta]));
  expect(button("Link 1 vault")).toBeDefined();
});

test("two same-render create submits dispatch one request", async () => {
  let finish!: (value: typeof linked) => void;
  createManaged.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await setup();
  const form = document.querySelector('[role="dialog"] form')!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(createManaged).toHaveBeenCalledTimes(1);
  expect(onLinked).not.toHaveBeenCalled();
  await act(async () => finish(linked));
});

for (const outcome of ["confirmed", "ordinary failure", "success"] as const) {
  test(`a second press after pending renders cannot complete the chooser: ${outcome}`, async () => {
    let resolve!: (value: typeof linked) => void;
    let reject!: (error: unknown) => void;
    createManaged.mockImplementation(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    await setup();
    const form = document.querySelector<HTMLFormElement>('[role="dialog"] form')!;
    try {
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(form.getAttribute("aria-busy")).toBe("true");
      expect(button("Creating…")).toBeDefined();
      expect(onLinked).not.toHaveBeenCalled();

      // Unlike the same-render fence, FormFrame now sees pending=true and
      // returns before the managed dialog's own onSubmit callback runs.
      await act(async () => button("Creating…")!.click());
      expect(createManaged).toHaveBeenCalledTimes(1);
      expect(onLinked).not.toHaveBeenCalled();
      expect(link).not.toHaveBeenCalled();

      await act(async () => {
        if (outcome === "success") resolve(linked);
        else
          reject(
            fail(
              "provider_unavailable",
              outcome === "confirmed"
                ? {
                    created: true,
                    linked: true,
                    vaultId: linked.id,
                    externalVaultId: meta.externalVaultId,
                  }
                : {},
            ),
          );
      });
      expect(createManaged).toHaveBeenCalledTimes(1);
      expect(onLinked).not.toHaveBeenCalled();
      if (outcome === "ordinary failure") {
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        expect(button("Create vault")!.disabled).toBe(false);
      } else {
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(host.textContent).toContain(
          outcome === "confirmed" ? "Don't create it again." : "Created · Read & write",
        );
      }
    } finally {
      await act(async () => resolve(linked));
    }
  });
}
