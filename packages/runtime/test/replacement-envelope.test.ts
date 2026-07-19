import { describe, expect, test } from "bun:test";
import {
  serializeReplacementSandboxEnvelope,
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

    expect(envelope).toHaveProperty(
      "sessionState.workspaceArchiveMeta.revision",
      "wa1:verified",
    );
    expect(envelope).not.toHaveProperty("sessionState.providerState");
    expect(JSON.stringify(envelope)).not.toContain("sb-dead-provider");
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
      sessionState: {
        providerState: {
          sandboxId: "sb-replacement",
          appName: "replacement-app",
        },
        workspaceArchiveMeta: { revision: "wa1:verified" },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("sb-dead-provider");
  });

  test("failed serialization without an archive publishes null", async () => {
    const envelope = await serializeReplacementSandboxEnvelope(
      replacement({ backendId: "modal" } as never, { sandboxId: "sb-replacement" }),
      null,
    );

    expect(envelope).toBeNull();
  });
});