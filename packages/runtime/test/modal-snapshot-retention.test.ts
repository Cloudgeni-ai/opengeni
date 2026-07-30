import { describe, expect, mock, test } from "bun:test";
import { ModalClient } from "modal";
import { installOpenGeniModalSnapshotPolicy } from "../src/sandbox/providers/modal";

type Persistence = "tar" | "snapshot_filesystem" | "snapshot_directory";

function fakeSession(
  persistence: Persistence,
  sandbox?: Record<string, unknown>,
  sdkVersion = "0.9.0",
) {
  const state = {
    workspacePersistence: persistence,
    snapshotFilesystemTimeoutMs: 120_000,
  };
  const session = {
    modal: { version: () => sdkVersion },
    sandbox,
    state,
    persistWorkspace: mock(async () => {
      if (state.workspacePersistence === "snapshot_filesystem") {
        await (
          session.sandbox?.snapshotFilesystem as
            | ((timeoutMs?: number) => Promise<unknown>)
            | undefined
        )?.(state.snapshotFilesystemTimeoutMs);
      } else if (state.workspacePersistence === "snapshot_directory") {
        await (
          session.sandbox?.snapshotDirectory as ((path: string) => Promise<unknown>) | undefined
        )?.("/workspace");
      }
      return new Uint8Array([1]);
    }),
  };
  return session;
}

describe("OpenGeni Modal 0.9 snapshot policy", () => {
  test("the runtime resolves the exact supported Modal SDK", () => {
    const modal = new ModalClient({
      tokenId: "test-token-id",
      tokenSecret: "test-token-secret",
    });
    try {
      expect(modal.version()).toBe("0.9.0");
    } finally {
      modal.close();
    }
  });

  test("translates snapshot_filesystem timeout and disables provider expiry", async () => {
    const snapshotFilesystem = mock(async (_params?: unknown) => ({ imageId: "im-fs" }));
    const session = fakeSession("snapshot_filesystem", { snapshotFilesystem });

    installOpenGeniModalSnapshotPolicy(session);
    await session.persistWorkspace();

    expect(snapshotFilesystem).toHaveBeenCalledTimes(1);
    expect(snapshotFilesystem.mock.calls[0]?.[0]).toEqual({
      timeoutMs: 120_000,
      ttlMs: null,
    });
  });

  test("passes snapshot_directory timeout and disables provider expiry", async () => {
    const snapshotDirectory = mock(async (_path: string, _params?: unknown) => ({
      imageId: "im-dir",
    }));
    const session = fakeSession("snapshot_directory", { snapshotDirectory });

    installOpenGeniModalSnapshotPolicy(session);
    await session.persistWorkspace();

    expect(snapshotDirectory).toHaveBeenCalledTimes(1);
    expect(snapshotDirectory.mock.calls[0]?.[0]).toBe("/workspace");
    expect(snapshotDirectory.mock.calls[0]?.[1]).toEqual({
      timeoutMs: 120_000,
      ttlMs: null,
    });
  });

  test("rebinds the policy after filesystem hydration replaces the sandbox", async () => {
    const firstSnapshot = mock(async (_params?: unknown) => ({ imageId: "im-first" }));
    const secondSnapshot = mock(async (_params?: unknown) => ({ imageId: "im-second" }));
    const session = fakeSession("snapshot_filesystem", {
      snapshotFilesystem: firstSnapshot,
    });

    installOpenGeniModalSnapshotPolicy(session);
    await session.persistWorkspace();
    session.sandbox = { snapshotFilesystem: secondSnapshot };
    await session.persistWorkspace();

    expect(firstSnapshot.mock.calls[0]?.[0]).toEqual({
      timeoutMs: 120_000,
      ttlMs: null,
    });
    expect(secondSnapshot.mock.calls[0]?.[0]).toEqual({
      timeoutMs: 120_000,
      ttlMs: null,
    });
  });

  test("leaves tar persistence unchanged", async () => {
    const session = fakeSession("tar");
    const originalPersistWorkspace = session.persistWorkspace;

    installOpenGeniModalSnapshotPolicy(session);
    installOpenGeniModalSnapshotPolicy(session);
    await session.persistWorkspace();

    expect(originalPersistWorkspace).toHaveBeenCalledTimes(1);
  });

  test("fails closed on an unsupported SDK or native session shape", () => {
    expect(() =>
      installOpenGeniModalSnapshotPolicy(
        fakeSession("snapshot_filesystem", { snapshotFilesystem: async () => undefined }, "0.7.6"),
      ),
    ).toThrow("requires modal@0.9.0");
    expect(() =>
      installOpenGeniModalSnapshotPolicy(fakeSession("snapshot_filesystem", {})),
    ).toThrow("snapshot_filesystem persistence is unavailable");
  });
});
