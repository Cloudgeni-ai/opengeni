import { describe, expect, test } from "bun:test";
import { DestinationPolicyError, pinnedFetch } from "@opengeni/network";
import { createProviderCallBudget, type RemoteVaultHttpRequest } from "@opengeni/vaults";
import {
  createPinnedRemoteVaultTransport,
  createRemoteExternalVaultFactories,
} from "../src/domain/vaults/remote-provider-runtime";
import {
  createExternalVaultReceiver,
  createInMemoryExternalVaultReceiverStore,
} from "../../sdk/src/external-vault-receiver";

const production = { environment: "production", integrationsAllowPrivateNetworkTargets: false };
const request: RemoteVaultHttpRequest = {
  url: "https://vault.example.test/endpoint",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: '{"exact":"bytes"}',
  timeoutMs: 100,
  maxResponseBytes: 64,
};

describe("remote vault production transport", () => {
  test("passes exact bytes, pinned policy, manual redirects and a signal", async () => {
    let called = false;
    const transport = createPinnedRemoteVaultTransport(
      production,
      async (url, init, policy, options) => {
        called = true;
        expect(url).toBe(request.url);
        expect(init?.body).toBe(request.body);
        expect(init?.redirect).toBe("manual");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(policy).toEqual(production);
        expect(options?.requireHttpsOutsideLocalTest).toBe(true);
        return new Response("ok");
      },
    );
    expect(await transport.post(request)).toMatchObject({ status: 200, body: "ok" });
    expect(called).toBe(true);
  });

  test("refuses private destinations before sending any signed bytes", async () => {
    const transport = createPinnedRemoteVaultTransport(production);
    await expect(
      transport.post({ ...request, url: "https://127.0.0.1/vault" }),
    ).rejects.toMatchObject({
      failure: "refused",
      requestSent: false,
    });
  });

  test("preserves definite DNS refusal and hides the endpoint's error", async () => {
    const transport = createPinnedRemoteVaultTransport(production, async () => {
      throw new DestinationPolicyError("dns_failed", "sensitive-host-and-token");
    });
    await expect(transport.post(request)).rejects.toMatchObject({
      failure: "refused",
      requestSent: false,
    });
  });

  test("refuses redirects, oversized bodies and network loss without retry", async () => {
    for (const [response, failure] of [
      [
        new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } }),
        "redirect",
      ],
      [new Response("x".repeat(65)), "too_large"],
      [new Response("small", { headers: { "content-length": "100" } }), "too_large"],
    ] as const) {
      let calls = 0;
      const transport = createPinnedRemoteVaultTransport(production, async () => {
        calls++;
        return response;
      });
      await expect(transport.post(request)).rejects.toMatchObject({ failure, requestSent: true });
      expect(calls).toBe(1);
    }
    let calls = 0;
    const transport = createPinnedRemoteVaultTransport(production, async () => {
      calls++;
      throw new Error("sensitive response");
    });
    await expect(transport.post(request)).rejects.toMatchObject({
      failure: "network",
      requestSent: true,
    });
    expect(calls).toBe(1);
  });

  test("bounds stalled lookup/headers and body reads by one deadline", async () => {
    const never: typeof pinnedFetch = async () => new Promise(() => undefined);
    for (const fetchImpl of [never, async () => new Response(new ReadableStream({ start() {} }))]) {
      const transport = createPinnedRemoteVaultTransport(production, fetchImpl);
      await expect(transport.post({ ...request, timeoutMs: 10 })).rejects.toMatchObject({
        failure: "timeout",
        requestSent: true,
      });
    }
  });

  test("an already-aborted call never dispatches", async () => {
    let calls = 0;
    const transport = createPinnedRemoteVaultTransport(production, async () => {
      calls++;
      return new Response("ok");
    });
    await expect(transport.post({ ...request, signal: AbortSignal.abort() })).rejects.toMatchObject(
      {
        failure: "aborted",
        requestSent: false,
      },
    );
    expect(calls).toBe(0);
  });

  test("production factories reject insecure and credential-bearing endpoints", async () => {
    const factories = createRemoteExternalVaultFactories(production);
    for (const endpoint of [
      "http://127.0.0.1:8080",
      "https://user:password@vault.example",
      "https://vault.example/#token",
    ]) {
      await expect(
        factories.external!({
          credentials: { provider: "external", endpoint, signingSecret: "fixture-signing-key" },
        }),
      ).rejects.toMatchObject({ code: "provider_auth_invalid" });
    }
  });

  test("real pinned HTTP transport interoperates with the SDK receiver and rechecks authority", async () => {
    const signingSecret = "fixture-only-remote-vault-signing-secret";
    const connectionId = crypto.randomUUID();
    const seen: string[] = [];
    const receiver = createExternalVaultReceiver({
      resolveConnection: async (id) =>
        id === connectionId
          ? {
              provider: "external",
              signingSecrets: [signingSecret],
              accountId: "native-account",
              connectionWorkspaceId: "native-workspace",
              context: { tenant: "host-tenant" },
            }
          : null,
      authorize: async ({ authority, operation }) => {
        seen.push(operation.op);
        return authority.subjectId === "native-person" ? { user: "host-person" } : null;
      },
      store: createInMemoryExternalVaultReceiverStore(),
      handlers: {
        describe: async () => ({
          result: {
            accountId: "host-tenant",
            accountName: "Product vault",
            inventoryScope: "connection",
            operations: {
              createItemTypes: [],
              updateItem: false,
              removeField: false,
              archiveItem: false,
              archiveKind: "none",
              deleteItem: false,
              restoreItem: false,
              readFiles: false,
              writeFiles: false,
              createTotp: false,
              updateTotp: false,
              createVault: false,
              restoreFieldHistory: false,
            },
            capabilities: { totp: true, files: false },
          },
        }),
        listVaults: async () => ({
          result: {
            items: [
              {
                externalVaultId: "v",
                name: "Product",
                contentVersion: null,
                itemCount: 1,
                writeAccess: "read_only",
              },
            ],
            nextCursor: null,
            snapshot: "s1",
          },
        }),
        listItems: async () => ({ result: { items: [], nextCursor: null, snapshot: "s1" } }),
        readFields: async () => ({
          result: {
            fields: [
              { externalFieldId: "password", value: { type: "text", value: "fixture-value" } },
            ],
          },
        }),
      },
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => receiver.fetch(req),
    });
    try {
      const factories = createRemoteExternalVaultFactories({
        environment: "test",
        integrationsAllowPrivateNetworkTargets: false,
      });
      const { provider } = await factories.external!({
        credentials: { provider: "external", endpoint: server.url.href, signingSecret },
      });
      const context = {
        connectionId,
        budget: createProviderCallBudget(10),
        authority: {
          accountId: "native-account",
          workspaceId: "native-workspace",
          connectionWorkspaceId: "native-workspace",
          subjectId: "native-person",
        },
      };
      expect(await provider.validate(context)).toMatchObject({ accountId: "host-tenant" });
      expect(await provider.listVaults(context)).toMatchObject([
        { externalVaultId: "v", name: "Product" },
      ]);
      expect(await provider.readFields(context, "v", "item", ["password"])).toMatchObject([
        { externalFieldId: "password", material: { type: "text", value: "fixture-value" } },
      ]);
      await expect(
        provider.readFields(
          { ...context, authority: { ...context.authority, subjectId: "other-person" } },
          "v",
          "item",
          ["password"],
        ),
      ).rejects.toMatchObject({ code: "provider_permission_denied" });
      expect(seen).toEqual(["describe", "list_vaults", "read_fields", "read_fields"]);
    } finally {
      await server.stop(true);
    }
  });
});
