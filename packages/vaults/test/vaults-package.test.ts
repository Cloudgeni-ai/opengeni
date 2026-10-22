import { describe, expect, test } from "bun:test";
import {
  findSecretReferences,
  RequestHumanInputToolInput,
  SecretReferenceError,
  secretValueAtDispatch,
  tokenizeSecretText,
} from "@opengeni/contracts";
import {
  createProviderCallBudget,
  createVaultProviderRegistry,
  dialectFromShell,
  spliceShellCommand,
  VaultProviderError,
} from "../src/index";
import {
  createFakeVaultProvider,
  createStaticSecretResolver,
  runVaultProviderContractSuite,
} from "../src/testing/index";

runVaultProviderContractSuite("fake", async () => {
  const provider = createFakeVaultProvider({
    vaults: [
      {
        externalVaultId: "rw",
        name: "RW",
        items: [
          {
            name: "Test Login",
            fields: [
              { name: "username", value: "agent@example.test" },
              { name: "password", value: "fixture-password" },
              {
                name: "one-time password",
                kind: "totp",
                value: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=6&period=30",
              },
            ],
          },
        ],
      },
      { externalVaultId: "ro", name: "RO", readOnly: true },
    ],
  });
  return {
    provider,
    externalVaultId: "rw",
    readOnlyVaultId: "ro",
    fixtureItemName: "Test Login",
  };
});

describe("fake provider", () => {
  test("seeds items, records calls without values and charges the budget", async () => {
    const provider = createFakeVaultProvider({
      vaults: [
        {
          externalVaultId: "v1",
          name: "Team",
          items: [
            {
              externalItemId: "i1",
              name: "Login",
              fields: [
                { externalFieldId: "u", name: "username", value: "octo" },
                { externalFieldId: "p", name: "password", value: "hunter2" },
                { externalFieldId: "t", name: "totp", kind: "totp", value: "JBSWY3DPEHPK3PXP" },
              ],
            },
          ],
        },
      ],
    });
    const budget = createProviderCallBudget(2);
    const ctx = { connectionId: "c1", budget };
    const [items] = [await provider.listItems(ctx, "v1")];
    expect(items?.[0]?.fields.map((field) => field.kind)).toEqual(["text", "concealed", "totp"]);
    const values = await provider.readFields(ctx, "v1", "i1", ["p", "t"]);
    expect(values[0]?.material).toEqual({ type: "text", value: "hunter2" });
    expect(values[1]?.material.type).toBe("totp");
    expect(JSON.stringify(provider.calls)).not.toContain("hunter2");
    const error = await provider.listVaults(ctx).catch((caught: unknown) => caught);
    expect((error as VaultProviderError).code).toBe("provider_rate_limited");
  });

  test("failWith maps every call to a provider error", async () => {
    const provider = createFakeVaultProvider({ failWith: "provider_auth_expired" });
    const error = await provider
      .validate({ connectionId: null, budget: createProviderCallBudget(5) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VaultProviderError);
    expect((error as VaultProviderError).code).toBe("provider_auth_expired");
  });

  test("optimistic version check on update", async () => {
    const provider = createFakeVaultProvider({ vaults: [{ externalVaultId: "v", name: "V" }] });
    const ctx = { connectionId: null, budget: createProviderCallBudget(10) };
    const created = await provider.writeItem(ctx, "v", {
      name: "A",
      type: "login",
      websites: [],
      fields: [],
    });
    const error = await provider
      .writeItem(ctx, "v", {
        externalItemId: created.externalItemId,
        expectedVersion: "999",
        name: "A",
        type: "login",
        websites: [],
        fields: [],
      })
      .catch((caught: unknown) => caught);
    expect((error as VaultProviderError).code).toBe("provider_conflict");
  });
});

describe("registry", () => {
  test("routes by source and refuses missing providers", async () => {
    const fake = createFakeVaultProvider();
    const registry = createVaultProviderRegistry({ host: async () => fake });
    expect(await registry.forVault({ source: "host", providerConnectionId: null })).toBe(fake);
    const error = await registry
      .forVault({ source: "onepassword", providerConnectionId: "c" })
      .catch((caught: unknown) => caught);
    expect((error as VaultProviderError).code).toBe("provider_unavailable");
  });
});

describe("static resolver", () => {
  test("resolves all references or throws with a ready ask card", async () => {
    const resolver = createStaticSecretResolver({
      GitHub: "gh-token",
      "Team/Stripe/key": "sk_test",
      "GitHub#previous": "old-token",
      Totp: "JBSWY3DPEHPK3PXP",
    });
    const refs = findSecretReferences(
      "{{secret:GitHub}} {{secret:Team/Stripe/key}} {{secret:GitHub#previous}} {{secret:Totp/otp}} {{secret:GitHub}}",
    );
    const resolved = await resolver.resolve(refs, { surface: "shell", toolName: "exec_command" });
    expect(resolved.size).toBe(4);
    const values = await Promise.all(
      [...resolved.values()].map((value) => secretValueAtDispatch(value)),
    );
    expect(values.slice(0, 3)).toEqual(["gh-token", "sk_test", "old-token"]);
    expect(values[3]).toMatch(/^\d{6}$/);

    const error = await resolver
      .resolve(findSecretReferences("{{secret:GitHub}} {{secret:Missing}}"), {
        surface: "mcp",
        toolName: "x",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretReferenceError);
    const failure = error as SecretReferenceError;
    expect(failure.failures.map((entry) => entry.code)).toEqual(["not_found"]);
    expect(RequestHumanInputToolInput.safeParse(failure.askCard).success).toBe(true);
    expect(resolver.calls).toHaveLength(2);
    expect(JSON.stringify(resolver.calls)).not.toContain("gh-token");
  });
});

describe("splice contract", () => {
  test.each([
    [null, "linux", "posix"],
    [null, "darwin", "posix"],
    [null, "windows", "powershell"],
    [null, "unknown", "unknown"],
    ["/bin/bash", "linux", "posix"],
    ["/usr/bin/zsh", "darwin", "posix"],
    ["dash", "linux", "posix"],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "windows", "powershell"],
    ["pwsh", "linux", "powershell"],
    ["cmd.exe", "windows", "cmd"],
    ["/usr/bin/fish", "linux", "fish"],
    ["/opt/nu", "linux", "unknown"],
  ] as const)("dialectFromShell(%p, %p) = %p", (shell, os, expected) => {
    expect(dialectFromShell(shell, os)).toBe(expected);
  });

  test("binds each distinct reference once and refuses unsupported shells", () => {
    const text = "curl -u {{secret:A}}:{{secret:B}} {{secret:a}}";
    const result = spliceShellCommand(text, "posix", tokenizeSecretText(text));
    expect(result.bindings.map((binding) => binding.envName)).toEqual([
      "OPENGENI_SECRET_0",
      "OPENGENI_SECRET_1",
    ]);
    expect(result.text).not.toContain("{{secret");
    expect(() => spliceShellCommand(text, "cmd", tokenizeSecretText(text))).toThrow(
      SecretReferenceError,
    );
    const plain = "echo \\{{secret:kept}}";
    expect(spliceShellCommand(plain, "cmd", tokenizeSecretText(plain))).toEqual({
      text: "echo {{secret:kept}}",
      bindings: [],
    });
  });
});
