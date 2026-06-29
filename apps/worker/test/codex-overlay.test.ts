import { describe, expect, test } from "bun:test";
import { parseModelProvidersJson } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import type { Database } from "@opengeni/db";
import { settingsWithCodexCredential, withCodexProvider } from "../src/activities/capabilities";

describe("withCodexProvider", () => {
  test("appends one codex-subscription provider with namespaced models", () => {
    const settings = testSettings({ modelProvidersJson: "[]" });
    const result = withCodexProvider(settings);
    const providers = parseModelProvidersJson(result.modelProvidersJson);
    const codex = providers.find((p) => p.id === "codex-subscription");
    expect(codex).toBeDefined();
    expect(codex?.kind).toBe("codex-subscription");
    expect(codex?.api).toBe("responses");
    expect(codex?.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(codex?.models.every((m) => m.id.startsWith("codex/"))).toBe(true);
    expect(codex?.models.some((m) => m.id === "codex/gpt-5.5")).toBe(true);
  });

  test("preserves existing registry providers", () => {
    const existing = JSON.stringify([{ id: "fireworks", baseUrl: "https://api.fireworks.ai", models: [{ id: "glm" }] }]);
    const result = withCodexProvider(testSettings({ modelProvidersJson: existing }));
    const ids = parseModelProvidersJson(result.modelProvidersJson).map((p) => p.id);
    expect(ids).toContain("fireworks");
    expect(ids).toContain("codex-subscription");
  });

  test("is idempotent — a second call does not double-inject", () => {
    const once = withCodexProvider(testSettings({ modelProvidersJson: "[]" }));
    const twice = withCodexProvider(once);
    expect(twice).toBe(once); // same reference: no change
    expect(parseModelProvidersJson(twice.modelProvidersJson).filter((p) => p.id === "codex-subscription").length).toBe(1);
  });
});

describe("settingsWithCodexCredential", () => {
  test("is a no-op when the feature is disabled (never touches the db)", async () => {
    const settings = testSettings({ codexSubscriptionEnabled: false, modelProvidersJson: "[]" });
    const result = await settingsWithCodexCredential(undefined as unknown as Database, "ws_1", settings);
    expect(result).toBe(settings); // same reference, no db access
  });
});
