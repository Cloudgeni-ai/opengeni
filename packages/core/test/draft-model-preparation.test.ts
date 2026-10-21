import { describe, expect, mock, spyOn, test } from "bun:test";
import { configuredModels, withCodexCatalogProvider } from "@opengeni/config";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { prepareDraftModel } from "../src/application/draft-model-preparation";

const settings = withCodexCatalogProvider(testSettings({ codexSubscriptionEnabled: true }));
const context = { accountId: "account", workspaceId: "workspace", subjectId: "user:person" };
const codexModel = configuredModels(settings).find(
  (model) =>
    model.credentialSource.kind === "connected_subscription" &&
    model.credentialSource.provider === "codex",
)!;
const draft = { text: "A draft", resources: [], model: codexModel.id };
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe("draft model preparation", () => {
  test("a nearly expired stored fact suppresses hints only until its actual expiry", async () => {
    const deps = { db: {} as Database, settings };
    let now = 100_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const refresh = mock(async () => now + 1_000);
    try {
      prepareDraftModel(deps, context, draft, refresh);
      await flush();
      now += 999;
      prepareDraftModel(deps, context, draft, refresh);
      await flush();
      expect(refresh).toHaveBeenCalledTimes(1);
      now += 1;
      await flush();
      expect(refresh).toHaveBeenCalledTimes(1);
      prepareDraftModel(deps, context, draft, refresh);
      await flush();
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  test("coalesces edits, tabs and model switches without retaining draft content", async () => {
    const deps = { db: {} as Database, settings };
    const refresh = mock(async () => Date.now() + 60_000);
    prepareDraftModel(deps, context, draft, refresh);
    prepareDraftModel(deps, context, { ...draft, text: "Edited" }, refresh);
    prepareDraftModel(deps, context, { ...draft, model: codexModel.id }, refresh);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(deps.db, settings, context, undefined, {
      refreshCredentials: false,
    });
    prepareDraftModel(deps, context, draft, refresh);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("empty drafts, other providers and disabled subscriptions do nothing", async () => {
    const deps = { db: {} as Database, settings };
    const refresh = mock(async () => Date.now() + 60_000);
    prepareDraftModel(deps, context, { ...draft, text: "  " }, refresh);
    const directModel = configuredModels(settings).find(
      (model) => model.credentialSource.kind !== "connected_subscription",
    )!;
    expect(directModel).toBeDefined();
    prepareDraftModel(deps, context, { ...draft, model: directModel.id }, refresh);
    prepareDraftModel(
      { ...deps, settings: { ...settings, codexSubscriptionEnabled: false } },
      context,
      draft,
      refresh,
    );
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  test("pending work is single-flight; a failure retries only on an edit after five seconds", async () => {
    const deps = { db: {} as Database, settings };
    let reject!: (error: Error) => void;
    const refresh = mock(
      () =>
        new Promise<number>((_resolve, no) => {
          reject = no;
        }),
    );
    let now = 100_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      prepareDraftModel(deps, context, draft, refresh);
      await flush();
      now += 60_000;
      prepareDraftModel(deps, context, draft, refresh);
      await flush();
      expect(refresh).toHaveBeenCalledTimes(1);
      reject(new Error("unavailable"));
      await flush();
      now += 4_999;
      prepareDraftModel(deps, context, draft, refresh);
      await flush();
      expect(refresh).toHaveBeenCalledTimes(1);
      now += 1;
      prepareDraftModel(deps, context, draft, refresh);
      await flush();
      expect(refresh).toHaveBeenCalledTimes(2);
      reject(new Error("unavailable"));
      await flush();
    } finally {
      clock.mockRestore();
    }
  });

  test("a failed hint never rejects a draft save or shares another person's scope", async () => {
    const deps = { db: {} as Database, settings };
    const refresh = mock(async () => {
      throw new Error("unavailable");
    });
    expect(() => prepareDraftModel(deps, context, draft, refresh)).not.toThrow();
    prepareDraftModel(deps, { ...context, subjectId: "user:other" }, draft, refresh);
    prepareDraftModel(deps, { ...context, workspaceId: "another" }, draft, refresh);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
