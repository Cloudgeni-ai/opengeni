/**
 * Opt-in against this worktree's disposable full local stack:
 * EXTERNAL_VAULT_E2E_API=http://127.0.0.1:9000 \
 *   bun --env-file=.env --env-file=.env.runtime test ./test/e2e/external-vaults.e2e.ts
 *
 * Real HTTP API, SDK, PostgreSQL, signed receiver and shell dispatch. Provider
 * data is synthetic; this is not proof against a live password-manager account
 * or an agent/Connected Machine turn. No secret values are logged or retained.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { dbSearchPath, environmentsEncryptionKeyBytes, getSettings } from "@opengeni/config";
import {
  formatSecretReference,
  parseSecretReference,
  parseTotpInput,
  referenceKey,
  secretValueAtDispatch,
  tokenizeSecretText,
  totpCodeSync,
  type VaultProviderOperations,
} from "@opengeni/contracts";
import {
  createRemoteExternalVaultFactories,
  createSecretResolver,
  createWorkspaceVaultProviderRegistry,
} from "@opengeni/core";
import { createDb } from "@opengeni/db";
import { spliceShellCommand } from "../../packages/vaults/src/index";
import {
  createExternalVaultReceiver,
  createInMemoryExternalVaultReceiverStore,
  ExternalVaultReceiverError,
  type VaultProviderWireFreshness,
  type VaultProviderWireItemMeta,
} from "../../packages/sdk/src/external-vault-receiver";
import { OpenGeniClient } from "../../packages/sdk/src/client";
import { vaultsApi } from "../../packages/sdk/src/vaults-api";

const baseUrl = process.env.EXTERNAL_VAULT_E2E_API;
const operations: VaultProviderOperations = {
  createItemTypes: ["login", "note"],
  updateItem: true,
  removeField: true,
  archiveItem: true,
  archiveKind: "trash",
  deleteItem: false,
  restoreItem: false,
  readFiles: false,
  writeFiles: false,
  createTotp: true,
  updateTotp: true,
  createVault: false,
  restoreFieldHistory: false,
};
type FixtureItem = { meta: VaultProviderWireItemMeta; values: Map<string, string> };

describe.skipIf(!baseUrl)("external vault local-stack gate", () => {
  test("discovery, dispatch, refresh, outage recovery and writes", async () => {
    const base = new URL(baseUrl!);
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(base.hostname);
    const health = await fetch(new URL("/healthz", base)).then((response) => response.json());
    expect(health).toMatchObject({ environment: "local", ok: true });
    const settings = getSettings();
    expect(settings.environment).toBe("local");
    const workspaces = (await fetch(new URL("/v1/workspaces", base)).then((r) => r.json())) as {
      id: string;
      accountId: string;
      externalSource: string;
    }[];
    const workspace = workspaces.find((row) => row.externalSource === "opengeni:local")!;
    expect(workspace).toBeDefined();
    const api = vaultsApi(new OpenGeniClient({ baseUrl: base.href }), workspace.id);
    const signingSecret = randomBytes(32).toString("hex");
    const password = randomBytes(32).toString("hex");
    const replacement = randomBytes(32).toString("hex");
    const seed = "JBSWY3DPEHPK3PXP";
    const name = `Gate ${crypto.randomUUID().slice(0, 8)}`;
    const items = new Map<string, FixtureItem>([
      [
        "login",
        {
          meta: {
            externalItemId: "login",
            name: "Login",
            type: "login",
            websites: [],
            fields: [
              { externalFieldId: "password", name: "password", kind: "concealed" },
              { externalFieldId: "totp", name: "authenticator", kind: "totp" },
            ],
            version: "1",
            updatedAt: new Date().toISOString(),
          },
          values: new Map([
            ["password", password],
            ["totp", seed],
          ]),
        },
      ],
      [
        "note",
        {
          meta: {
            externalItemId: "note",
            name: "Note",
            type: "note",
            websites: [],
            fields: [{ externalFieldId: "note", name: "note", kind: "text" }],
            version: "1",
            updatedAt: new Date().toISOString(),
          },
          values: new Map([["note", "Synthetic note"]]),
        },
      ],
    ]);
    let connectionId: string | null = null;
    let registeredId: string | null = null;
    let unavailable = false;
    let reads = 0;
    let writes = 0;
    let revision = 1;
    const freshness = (): VaultProviderWireFreshness => ({
      state: "current",
      source: "live",
      sourceSyncedAt: new Date().toISOString(),
      errorCode: null,
      retryAt: null,
    });
    const receiver = createExternalVaultReceiver({
      resolveConnection: async (id) =>
        id === registeredId
          ? {
              provider: "external",
              signingSecrets: [signingSecret],
              accountId: workspace.accountId,
              connectionWorkspaceId: workspace.id,
              context: { tenant: "fixture" },
            }
          : null,
      authorize: async ({ authority, connection }) => {
        expect(connection).toEqual({ tenant: "fixture" });
        return authority.accountId === workspace.accountId &&
          authority.workspaceId === workspace.id &&
          authority.subjectId === "dev"
          ? { user: "fixture-user" }
          : null;
      },
      store: createInMemoryExternalVaultReceiverStore(),
      handlers: {
        describe: async () => ({
          result: {
            accountId: "fixture",
            accountName: "Local gate",
            inventoryScope: "connection",
            operations,
            capabilities: { totp: true, files: false },
          },
        }),
        refresh: async () => {
          if (unavailable) throw new ExternalVaultReceiverError("provider_unavailable");
          return { result: { refreshed: true }, freshness: freshness() };
        },
        listVaults: async () => ({
          result: {
            items: [
              {
                externalVaultId: "vault",
                name,
                contentVersion: String(revision),
                itemCount: items.size,
                writeAccess: "read_write",
              },
            ],
            nextCursor: null,
            snapshot: String(revision),
          },
          freshness: freshness(),
        }),
        listItems: async (_ctx, input) => {
          if (unavailable) throw new ExternalVaultReceiverError("provider_unavailable");
          const offset = Number(input.page.cursor ?? "0");
          // Force two pages even when the consumer requests the maximum.
          const all = [...items.values()].map((row) => row.meta);
          return {
            result: {
              items: all.slice(offset, offset + 1),
              nextCursor: offset + 1 < all.length ? String(offset + 1) : null,
              snapshot: String(revision),
            },
            freshness: freshness(),
          };
        },
        readFields: async (_ctx, input) => {
          if (unavailable) throw new ExternalVaultReceiverError("provider_unavailable");
          reads++;
          const row = items.get(input.externalItemId);
          if (!row) throw new ExternalVaultReceiverError("provider_not_found");
          return {
            result: {
              fields: input.externalFieldIds.map((externalFieldId) => ({
                externalFieldId,
                value: {
                  type: externalFieldId === "totp" ? ("totp" as const) : ("text" as const),
                  value: row.values.get(externalFieldId)!,
                },
              })),
            },
            freshness: freshness(),
          };
        },
        writeItem: async (_ctx, { item }) => {
          writes++;
          const id = item.externalItemId ?? crypto.randomUUID();
          const previous = items.get(id);
          if (previous && item.expectedVersion && item.expectedVersion !== previous.meta.version)
            throw new ExternalVaultReceiverError("provider_conflict");
          const values = new Map(previous?.values);
          const fields = new Map(
            previous?.meta.fields.map((field) => [field.externalFieldId, field]),
          );
          for (const field of item.fields) {
            const fieldId = field.externalFieldId ?? crypto.randomUUID();
            if (field.remove) {
              fields.delete(fieldId);
              values.delete(fieldId);
              continue;
            }
            fields.set(fieldId, { externalFieldId: fieldId, name: field.name, kind: field.kind });
            if (field.value !== undefined) values.set(fieldId, field.value);
          }
          const meta: VaultProviderWireItemMeta = {
            externalItemId: id,
            name: item.name,
            type: item.type,
            websites: item.websites,
            fields: [...fields.values()],
            version: String(++revision),
            updatedAt: new Date().toISOString(),
          };
          items.set(id, { meta, values });
          return { result: { item: meta }, freshness: freshness() };
        },
        archiveItem: async (_ctx, input) => {
          writes++;
          items.delete(input.externalItemId);
          revision++;
          return { result: { archived: true }, freshness: freshness() };
        },
      },
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => receiver.fetch(req),
    });
    const searchPath = dbSearchPath(settings);
    const db = createDb(settings.databaseUrl, {
      ...(searchPath ? { searchPath } : {}),
      rlsStrategy: settings.rlsStrategy,
      max: 2,
    });
    try {
      const installed = await api.installVaultProvider({
        ownership: "workspace",
        credentials: {
          provider: "external",
          endpoint: server.url.href,
          signingSecret,
        },
      });
      connectionId = installed.connectionId;
      expect(installed.discoveryPending).toBe(true);
      registeredId = connectionId;
      expect((await api.verifyVaultProviderConnection(connectionId)).discoveryPending).not.toBe(
        true,
      );
      const vault = await api.linkProviderVault({
        provider: "external",
        connectionId,
        externalVaultId: "vault",
        ownerKind: "workspace",
        mode: "read_write",
        name,
      });
      await api.syncVault(vault.id);
      const first = await api.listItems(vault.id, { limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await api.listItems(vault.id, { limit: 1, cursor: first.nextCursor! });
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const listed = [...first.items, ...second.items];
      expect(reads).toBe(0);
      expect(JSON.stringify(listed).includes(password)).toBe(false);
      expect(JSON.stringify(await api.getVaultProviderCatalog()).includes(signingSecret)).toBe(
        false,
      );
      const login = await api.getItem(vault.id, listed.find((item) => item.name === "Login")!.id);
      const passwordField = login.fields.find((field) => field.name === "password")!;
      expect((await api.revealField(vault.id, login.id, passwordField.id)).value === password).toBe(
        true,
      );
      const otpField = login.fields.find((field) => field.kind === "totp")!;
      const revealedOtp = await api.revealField(vault.id, login.id, otpField.id);
      expect(revealedOtp.totp?.code).toMatch(/^\d{6}$/);
      const providers = createWorkspaceVaultProviderRegistry({
        db: db.db,
        settings,
        workspaceId: workspace.id,
        subjectId: "dev",
        externalVaultProviders: createRemoteExternalVaultFactories(settings),
      });
      const resolver = createSecretResolver(
        { db: db.db, providers, encryptionKey: environmentsEncryptionKeyBytes(settings) },
        {
          kind: "human",
          accountId: workspace.accountId,
          workspaceId: workspace.id,
          subjectId: "dev",
          verifiedHuman: true,
          viaApiKey: false,
        },
        { capabilityEnabled: true },
      );
      const ref = parseSecretReference(
        formatSecretReference({ vault: name, item: "Login", field: "password" }),
      )!;
      const command = `printf %s '${ref.raw}'`;
      const spliced = spliceShellCommand(command, "posix", tokenizeSecretText(command));
      expect(spliced.text.includes(password)).toBe(false);
      const resolved = await resolver.resolve([ref], {
        surface: "shell",
        toolName: "exec_command",
      });
      const env: Record<string, string> = {};
      for (const binding of spliced.bindings)
        env[binding.envName] = (await secretValueAtDispatch(resolved.get(binding.key)!)) as string;
      const child = Bun.spawn(["/bin/bash", "-c", spliced.text], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output === password).toBe(true);
      const otpRef = parseSecretReference(
        formatSecretReference({ vault: name, item: "Login", otp: true }),
      )!;
      const otpValues = await resolver.resolve([otpRef], {
        surface: "codemode",
        toolName: "fixture",
      });
      const before = Date.now();
      const otp = await secretValueAtDispatch(otpValues.get(referenceKey(otpRef))!);
      const params = parseTotpInput(seed);
      expect(
        [totpCodeSync(params, before), totpCodeSync(params, Date.now())].includes(otp as string),
      ).toBe(true);
      items.get("login")!.values.set("password", replacement);
      items.get("login")!.meta.version = String(++revision);
      await api.syncVault(vault.id);
      const fresh = await resolver.resolve([ref], { surface: "codemode", toolName: "fixture" });
      expect((await secretValueAtDispatch(fresh.get(referenceKey(ref))!)) === replacement).toBe(
        true,
      );
      const created = await api.createItem(vault.id, {
        name: "Created",
        type: "note",
        fields: [{ name: "note", kind: "text", value: "Synthetic create" }],
      });
      const updated = await api.updateItem(vault.id, created.id, {
        expectedGeneration: created.generation,
        name: "Updated",
      });
      expect(updated.name).toBe("Updated");
      await api.deleteItem(vault.id, created.id);
      expect(writes).toBe(3);
      expect((await api.listItems(vault.id)).items).toHaveLength(2);
      unavailable = true;
      await api.syncVault(vault.id).catch(() => undefined);
      expect((await api.getVault(vault.id)).freshness?.state).toBe("unavailable");
      expect((await api.listItems(vault.id)).items).toHaveLength(2);
      await expect(api.revealField(vault.id, login.id, passwordField.id)).rejects.toThrow();
      unavailable = false;
      expect((await api.syncVault(vault.id)).freshness?.state).toBe("current");
      expect(
        (await api.revealField(vault.id, login.id, passwordField.id)).value === replacement,
      ).toBe(true);
    } finally {
      try {
        if (connectionId) await api.disconnectVaultProvider(connectionId);
      } finally {
        await Promise.allSettled([server.stop(true), db.close()]);
      }
    }
  }, 180_000);
});
