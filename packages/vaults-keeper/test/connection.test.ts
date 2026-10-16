import { describe, expect, test } from "bun:test";
import {
  createProviderCallBudget,
  providerOperations,
  VaultProviderError,
  type VaultProvider,
} from "@opengeni/vaults";
import { openKeeperConnection } from "../src/connection";
import { KEEPER_OPERATIONS } from "../src/provider";
import { restrictToOperations } from "../src/operations";
import { FakeKsm, loginData } from "./fake-ksm";

const ctx = () => ({ connectionId: "conn-open", budget: createProviderCallBudget(50) });

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(VaultProviderError);
  return (error as VaultProviderError).code;
}

describe("openKeeperConnection", () => {
  test("binds, saves the record first, then saves rotations as records", async () => {
    const fake = new FakeKsm();
    const folder = fake.addFolder("Ops");
    fake.addRecord(folder.uid, loginData("Deploy"));
    const saved: Array<{ configuration: Record<string, string>; reason: string }> = [];
    const opened = await openKeeperConnection({
      credentials: { oneTimeToken: fake.createToken() },
      persistConfiguration: async (configuration, { reason }) => {
        saved.push({ configuration, reason });
      },
      queryFunction: fake.queryFunction,
    });
    expect(saved).toEqual([{ configuration: opened.configuration, reason: "bind" }]);
    expect(opened.configuration.appKey).toBeTruthy();
    expect(opened.configuration.clientKey).toBeUndefined();

    fake.hooks.requireKeyId = 8;
    expect(await opened.provider.listVaults(ctx())).toHaveLength(1);
    expect(saved).toHaveLength(2);
    expect(saved[1]!.reason).toBe("rotation");
    expect(saved[1]!.configuration.serverPublicKeyId).toBe("8");
  });

  test("refuses without durable storage, before any request", async () => {
    const fake = new FakeKsm();
    expect(
      await code(
        openKeeperConnection({
          credentials: { oneTimeToken: fake.createToken() },
          queryFunction: fake.queryFunction,
        }),
      ),
    ).toBe("provider_unavailable");
    expect(fake.requests).toHaveLength(0);
  });

  test("opens a stored record and rejects an unbound one", async () => {
    const fake = new FakeKsm();
    fake.addFolder("Ops");
    const first = await openKeeperConnection({
      credentials: { oneTimeToken: fake.createToken() },
      persistConfiguration: async () => {},
      queryFunction: fake.queryFunction,
    });
    const again = await openKeeperConnection({
      credentials: { configuration: first.configuration },
      persistConfiguration: async () => {},
      queryFunction: fake.queryFunction,
    });
    expect(again.configuration).toEqual(first.configuration);
    expect(await again.provider.listVaults(ctx())).toHaveLength(1);
    const { appKey: _appKey, ...unbound } = first.configuration;
    expect(
      await code(
        openKeeperConnection({
          credentials: { configuration: unbound },
          persistConfiguration: async () => {},
        }),
      ),
    ).toBe("provider_auth_invalid");
  });
});

describe("restrictToOperations", () => {
  function stub() {
    const calls: string[] = [];
    const provider: VaultProvider = {
      id: "keeper",
      capabilities: () => ({
        write: true,
        createVault: false,
        totp: true,
        files: false,
        groupGrants: false,
        passkeys: false,
        operations: {
          ...KEEPER_OPERATIONS,
          createItemTypes: [...KEEPER_OPERATIONS.createItemTypes],
        },
      }),
      validate: async () => ({ accountName: null }),
      listVaults: async () => [],
      listItems: async () => [],
      readFields: async () => {
        calls.push("read");
        return [];
      },
      writeItem: async () => {
        calls.push("write");
        return {
          externalItemId: "x",
          name: "x",
          type: "login",
          websites: [],
          fields: [],
          version: null,
          updatedAt: null,
        };
      },
      archiveItem: async () => {
        calls.push("archive");
      },
    };
    return { provider, calls };
  }

  test("without verified operations the adapter is returned unchanged", () => {
    const { provider } = stub();
    expect(restrictToOperations(provider, undefined, "@file:")).toBe(provider);
  });

  test("narrows, never widens, and refuses before calling the adapter", async () => {
    const { provider, calls } = stub();
    const verified = {
      ...KEEPER_OPERATIONS,
      createItemTypes: ["login" as const, "api_key" as const],
      updateItem: true,
      removeField: false,
      updateTotp: false,
      createTotp: false,
      readFiles: false,
      archiveItem: true,
      archiveKind: "archive" as const,
    };
    const narrowed = restrictToOperations(provider, verified, "@file:");
    const operations = narrowed.capabilities().operations!;
    // api_key is not a Keeper create type, and archive is not a Keeper operation.
    expect(operations.createItemTypes).toEqual(["login"]);
    expect(operations.archiveItem).toBe(false);
    expect(operations.deleteItem).toBe(false);
    expect(operations.readFiles).toBe(false);

    const create = { name: "n", type: "login" as const, websites: [], fields: [] };
    expect(await code(narrowed.writeItem(ctx(), "f", { ...create, type: "note" }))).toBe(
      "provider_permission_denied",
    );
    expect(
      await code(
        narrowed.writeItem(ctx(), "f", {
          ...create,
          fields: [{ name: "otp", kind: "totp", value: "JBSWY3DPEHPK3PXP" }],
        }),
      ),
    ).toBe("provider_permission_denied");
    expect(
      await code(
        narrowed.writeItem(ctx(), "f", {
          ...create,
          externalItemId: "r",
          fields: [{ name: "old", kind: "text", remove: true }],
        }),
      ),
    ).toBe("provider_permission_denied");
    expect(await code(narrowed.readFields(ctx(), "f", "r", ["f:login", "@file:abc"]))).toBe(
      "provider_permission_denied",
    );
    expect(await code(narrowed.archiveItem(ctx(), "f", "r"))).toBe("provider_permission_denied");
    expect(calls).toEqual([]);

    await narrowed.writeItem(ctx(), "f", create);
    await narrowed.writeItem(ctx(), "f", { ...create, externalItemId: "r" });
    await narrowed.readFields(ctx(), "f", "r", ["f:login"]);
    expect(calls).toEqual(["write", "write", "read"]);
  });

  test("read-only setups report no write ability", () => {
    const { provider } = stub();
    const readOnly = providerOperations({
      write: false,
      createVault: false,
      totp: false,
      files: false,
      groupGrants: false,
      passkeys: false,
    });
    expect(restrictToOperations(provider, readOnly, "@file:").capabilities().write).toBe(false);
  });
});
