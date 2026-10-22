import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import {
  startGoogleDriveOAuth,
  completeGoogleDriveOAuthCallback,
  saveGoogleDriveFacetSource,
} from "../src/integrations/google-drive";
import { createSignedState } from "@opengeni/github";

test("retired native OAuth and source authoring cannot create credentials even with configured clients", async () => {
  const effects = new Proxy(
    {},
    {
      get() {
        throw new Error("Unexpected database effect");
      },
    },
  );
  const settings = testSettings({
    integrationsEnabled: true,
    googleDriveClientId: "fixture",
    googleDriveClientSecret: "fixture",
  });
  const deps = { db: effects, settings } as any;
  await expect(startGoogleDriveOAuth(deps, {} as any)).rejects.toMatchObject({ status: 410 });
  await expect(saveGoogleDriveFacetSource(deps, {} as any)).rejects.toMatchObject({ status: 410 });
});

test("signed states from another flow cannot redeem a native Google Drive grant", async () => {
  let calls = 0;
  const settings = testSettings({
    integrationsStateSecret: "fixture-state",
    googleDriveClientId: "fixture",
    googleDriveClientSecret: "fixture",
    environmentsEncryptionKey: Buffer.alloc(32, 1).toString("base64"),
  });
  for (const kind of ["mcp_oauth", "atlassian_oauth", undefined]) {
    const state = createSignedState("fixture-state", {
      kind,
      accountId: "account",
      workspaceId: "workspace",
      subjectId: "human",
      nonce: crypto.randomUUID(),
      iat: Math.floor(Date.now() / 1000),
    });
    const result = await completeGoogleDriveOAuthCallback(
      {
        settings,
        db: {},
        googleDriveFetch: async () => {
          calls++;
          throw new Error("Unexpected provider request");
        },
      } as any,
      {
        state,
        code: "unused",
        requestUrl: "http://127.0.0.1:3000/v1/integrations/google-drive/callback",
      },
    );
    expect(result.redirectTo).toContain("error");
  }
  expect(calls).toBe(0);
});

test("a valid in-flight native callback returns retirement without credentials or provider access", async () => {
  const settings = testSettings({ integrationsStateSecret: "fixture-state" });
  const state = createSignedState("fixture-state", {
    kind: "google_drive_oauth",
    accountId: "account",
    workspaceId: "workspace",
    subjectId: "human",
    personalOwnerVerified: true,
    returnPath: "/workspaces/workspace/capabilities",
    encryptedPkceVerifier: "never-decrypted",
    nonce: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
  });
  const effects = new Proxy(
    {},
    {
      get() {
        throw new Error("Unexpected effect");
      },
    },
  );
  const result = await completeGoogleDriveOAuthCallback({ settings, db: effects } as any, {
    state,
    code: "unused",
    requestUrl: "http://127.0.0.1:3000/v1/integrations/google-drive/callback",
  });
  expect(new URL(result.redirectTo).searchParams.get("reason")).toBe("google_drive_native_retired");
});
