import { expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  beginDriveConnect,
  resolveDriveConnectReturn,
  completeDriveConnectReturn,
} from "./drive-connect-return";

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  let outcome = {
    id: "attempt",
    providerId: "google-drive",
    ownership: "personal",
    state: "complete",
    credentialsCommitted: true,
    account: { id: "exact-account", providerId: "google-drive", ownership: "personal" },
  } as Record<string, unknown>;
  const beginConnect = mock(async () => ({
    id: "attempt",
    revision: 1,
    state: "credential_input",
  }));
  const advanceConnectAttempt = mock(async () => ({
    id: "attempt",
    nextAction: { type: "authorize", url: "https://accounts.google.com/consent" },
  }));
  const getConnectAttempt = mock(async () => outcome);
  const client = {
    beginConnect,
    connectTransport: () => ({ advance: advanceConnectAttempt, get: getConnectAttempt }),
  } as unknown as OpenGeniBrowserClient;
  return {
    storage,
    values,
    client,
    beginConnect,
    advanceConnectAttempt,
    getConnectAttempt,
    setOutcome: (value: Record<string, unknown>) => {
      outcome = value;
    },
  };
}

test("Drive return reads the exact durable account, scoped to its original workspace and return nonce", async () => {
  const f = fixture();
  expect(
    await beginDriveConnect({
      client: f.client,
      workspaceId: "display",
      connectionWorkspaceId: "owner",
      itemId: "drive",
      reconnectAccountId: "existing",
      returnUrl: "https://app.example/settings?connect_item=drive",
      storage: f.storage,
    }),
  ).toBe("https://accounts.google.com/consent");
  expect(f.beginConnect).toHaveBeenCalledWith(
    "owner",
    expect.objectContaining({
      providerId: "google-drive",
      ownership: "personal",
      reconnectAccountId: "existing",
    }),
  );
  expect(f.advanceConnectAttempt).toHaveBeenCalledWith(
    "owner",
    "attempt",
    expect.objectContaining({ expectedRevision: 1, action: { type: "credentials", values: {} } }),
  );
  const receipt = JSON.parse([...f.values.values()][0]!);
  await expect(
    resolveDriveConnectReturn({
      client: f.client,
      workspaceId: "display",
      nonce: "wrong",
      storage: f.storage,
    }),
  ).rejects.toThrow("could not be matched");
  expect(f.getConnectAttempt).not.toHaveBeenCalled();
  await expect(
    resolveDriveConnectReturn({
      client: f.client,
      workspaceId: "other",
      nonce: receipt.nonce,
      storage: f.storage,
    }),
  ).rejects.toThrow("could not be matched");
  expect(
    await resolveDriveConnectReturn({
      client: f.client,
      workspaceId: "display",
      nonce: receipt.nonce,
      storage: f.storage,
    }),
  ).toEqual({ itemId: "drive", connectionId: "exact-account" });
  expect(f.getConnectAttempt).toHaveBeenCalledWith("owner", "attempt");
  // StrictMode/effect cleanup can discard the first reader. The locator remains
  // until its active consumer confirms the connector was enabled.
  expect(
    await resolveDriveConnectReturn({
      client: f.client,
      workspaceId: "display",
      nonce: receipt.nonce,
      storage: f.storage,
    }),
  ).toEqual({ itemId: "drive", connectionId: "exact-account" });
  completeDriveConnectReturn("display", "different-return", f.storage);
  expect(f.values.size).toBe(1);
  completeDriveConnectReturn("display", receipt.nonce, f.storage);
  expect(f.values.size).toBe(0);
});

test("failed or incomplete Drive returns never produce an account to auto-enable", async () => {
  for (const state of ["failed", "requires_user_action", "complete"]) {
    const f = fixture();
    await beginDriveConnect({
      client: f.client,
      workspaceId: "workspace",
      itemId: "drive",
      returnUrl: "https://app.example/settings",
      storage: f.storage,
    });
    const receipt = JSON.parse([...f.values.values()][0]!);
    f.setOutcome({
      id: "attempt",
      providerId: "google-drive",
      ownership: "personal",
      state,
      credentialsCommitted: false,
      error: { message: "Provider rejected access" },
    });
    await expect(
      resolveDriveConnectReturn({
        client: f.client,
        workspaceId: "workspace",
        nonce: receipt.nonce,
        storage: f.storage,
      }),
    ).rejects.toThrow();
    expect(f.values.size).toBe(state === "failed" ? 0 : 1);
  }
});

test("a different provider or ownership cannot satisfy a saved Drive return", async () => {
  for (const patch of [{ providerId: "mcp-oauth" }, { ownership: "workspace" }]) {
    const f = fixture();
    await beginDriveConnect({
      client: f.client,
      workspaceId: "workspace",
      itemId: "drive",
      returnUrl: "https://app.example/settings",
      storage: f.storage,
    });
    const receipt = JSON.parse([...f.values.values()][0]!);
    f.setOutcome({
      id: "attempt",
      providerId: "google-drive",
      ownership: "personal",
      state: "complete",
      credentialsCommitted: true,
      ...patch,
    });
    await expect(
      resolveDriveConnectReturn({
        client: f.client,
        workspaceId: "workspace",
        nonce: receipt.nonce,
        storage: f.storage,
      }),
    ).rejects.toThrow("account changed");
  }
});
