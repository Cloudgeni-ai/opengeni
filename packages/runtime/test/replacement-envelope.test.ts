import { describe, expect, test } from "bun:test";
import {
  requirePersistableReplacementSandboxEnvelope,
  sandboxProviderInstanceIdFromEnvelope,
  serializeReplacementSandboxEnvelope,
  withoutSandboxProviderIdentity,
  type EstablishedSandboxSession,
} from "../src/sandbox";

const archiveSource = {
  backendId: "modal",
  sessionState: {
    providerState: {
      sandboxId: "sb-dead-provider",
      appName: "dead-app",
    },
    workspaceArchive: "ZHVyYWJsZS13b3Jrc3BhY2U=",
    workspaceArchiveMeta: { revision: "wa1:verified" },
    workspaceArchivePrev: "cHJldmlvdXMtd29ya3NwYWNl",
    workspaceArchivePrevMeta: { revision: "wa1:previous" },
    workspaceArchiveAt: "2030-01-02T03:04:05.000Z",
  },
};

function replacement(
  client: EstablishedSandboxSession["client"],
  sessionState: unknown,
): EstablishedSandboxSession {
  return {
    client,
    session: {},
    sessionState,
    instanceId: "sb-replacement",
    backendId: "modal",
    origin: "restored",
    restoredArchive: null,
  } as EstablishedSandboxSession;
}

describe("replacement sandbox envelope publication", () => {
  test("missing replacement state is never publishable", () => {
    expect(() => requirePersistableReplacementSandboxEnvelope(null, "modal")).toThrow(
      /could not be serialized/i,
    );
  });

  test("unsupported serialization publishes archive-only state, never the dead provider", async () => {
    const envelope = await serializeReplacementSandboxEnvelope(
      replacement({ backendId: "modal" } as never, { sandboxId: "sb-replacement" }),
      archiveSource,
    );

    expect(envelope).toEqual({
      backendId: "modal",
      sessionState: {
        workspaceArchive: "ZHVyYWJsZS13b3Jrc3BhY2U=",
        workspaceArchiveMeta: { revision: "wa1:verified" },
        workspaceArchivePrev: "cHJldmlvdXMtd29ya3NwYWNl",
        workspaceArchivePrevMeta: { revision: "wa1:previous" },
        workspaceArchiveAt: "2030-01-02T03:04:05.000Z",
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("sb-dead-provider");
  });

  test("throwing serialization publishes archive-only state, never the dead provider", async () => {
    const envelope = await serializeReplacementSandboxEnvelope(
      replacement(
        {
          backendId: "modal",
          async serializeSessionState() {
            throw new Error("provider serializer failed");
          },
        } as never,
        { sandboxId: "sb-replacement" },
      ),
      archiveSource,
    );

    expect(envelope).toHaveProperty("sessionState.workspaceArchiveMeta.revision", "wa1:verified");
    expect(envelope).not.toHaveProperty("sessionState.providerState");
    expect(JSON.stringify(envelope)).not.toContain("sb-dead-provider");
    expect(() => requirePersistableReplacementSandboxEnvelope(envelope, "modal")).toThrow(
      /could not be serialized/i,
    );
  });

  test("serialization refuses a provider state that names a different live instance", async () => {
    const envelope = await serializeReplacementSandboxEnvelope(
      replacement(
        {
          backendId: "modal",
          async serializeSessionState() {
            return { sandboxId: "sb-unexpected" };
          },
        } as never,
        { sandboxId: "sb-replacement" },
      ),
      archiveSource,
    );

    expect(envelope).not.toHaveProperty("opengeniProviderInstanceId");
    expect(envelope).not.toHaveProperty("sessionState.providerState");
    expect(() => requirePersistableReplacementSandboxEnvelope(envelope, "modal")).toThrow(
      /could not be serialized/i,
    );
  });

  test("successful serialization binds the replacement provider and preserves durable archives", async () => {
    const envelope = await serializeReplacementSandboxEnvelope(
      replacement(
        {
          backendId: "modal",
          async serializeSessionState() {
            return {
              sandboxId: "sb-replacement",
              appName: "replacement-app",
            };
          },
        } as never,
        { sandboxId: "sb-replacement" },
      ),
      archiveSource,
    );

    expect(envelope).toMatchObject({
      backendId: "modal",
      opengeniProviderInstanceId: "sb-replacement",
      sessionState: {
        providerState: {
          sandboxId: "sb-replacement",
          appName: "replacement-app",
        },
        workspaceArchiveMeta: { revision: "wa1:verified" },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("sb-dead-provider");
    expect(requirePersistableReplacementSandboxEnvelope(envelope, "modal")).toBe(envelope);
  });

  test("replacement publication rejects stable and SDK provider identity disagreement", () => {
    expect(() =>
      requirePersistableReplacementSandboxEnvelope(
        {
          backendId: "modal",
          opengeniProviderInstanceId: "stable-box",
          sessionState: { providerState: { sandboxId: "different-box" } },
        },
        "modal",
      ),
    ).toThrow(/identity mismatch/i);
  });

  test("reads every current SDK legacy identity while new state stays provider-neutral", () => {
    for (const [backendId, field, value] of [
      ["modal", "sandboxId", "sandbox-1"],
      ["runloop", "devboxId", "devbox-1"],
      ["blaxel", "sandboxIdentity", "blaxel-1:created:workspace"],
      ["docker", "containerId", "container-1"],
      ["unix_local", "workspaceRootPath", "/tmp/workspace-1"],
      ["selfhosted", "agentId", "agent-1"],
    ] as const) {
      expect(
        sandboxProviderInstanceIdFromEnvelope({
          backendId,
          sessionState: { providerState: { [field]: value } },
        }),
      ).toBe(value);
    }

    expect(
      sandboxProviderInstanceIdFromEnvelope({
        backendId: "future-provider",
        opengeniProviderInstanceId: "stable-1",
        sessionState: { providerState: { providerPrivateAddress: "opaque" } },
      }),
    ).toBe("stable-1");

    const unrelatedProviderId = {
      backendId: "modal",
      sessionState: { providerState: { id: "application-record-id" } },
    };
    expect(sandboxProviderInstanceIdFromEnvelope(unrelatedProviderId)).toBeNull();
    expect(sandboxProviderInstanceIdFromEnvelope(unrelatedProviderId, "modal")).toBeNull();
  });

  test("strips both stable and SDK provider identity from cold recovery state", () => {
    expect(
      withoutSandboxProviderIdentity({
        backendId: "runloop",
        opengeniProviderInstanceId: "devbox-dead",
        sessionState: {
          providerState: { devboxId: "devbox-dead" },
          workspaceArchive: "durable",
        },
      }),
    ).toEqual({
      backendId: "runloop",
      sessionState: { workspaceArchive: "durable" },
    });

    expect(
      withoutSandboxProviderIdentity({
        backendId: "modal",
        opengeniProviderInstanceId: "sb-flat-dead",
        providerState: { sandboxId: "sb-flat-dead", appName: "legacy" },
        workspaceArchive: "flat-archive",
      }),
    ).toEqual({ backendId: "modal", workspaceArchive: "flat-archive" });

    const mixed = withoutSandboxProviderIdentity({
      backendId: "modal",
      opengeniProviderInstanceId: "sb-stable-dead",
      providerState: { sandboxId: "sb-flat-dead" },
      sessionState: {
        providerState: { sandboxId: "sb-nested-dead" },
        workspaceArchive: "mixed-archive",
      },
    });
    expect(mixed).toEqual({
      backendId: "modal",
      sessionState: { workspaceArchive: "mixed-archive" },
    });
    expect(sandboxProviderInstanceIdFromEnvelope(mixed)).toBeNull();
  });

  test("failed serialization without an archive publishes null", async () => {
    const envelope = await serializeReplacementSandboxEnvelope(
      replacement({ backendId: "modal" } as never, { sandboxId: "sb-replacement" }),
      null,
    );

    expect(envelope).toBeNull();
  });
});
