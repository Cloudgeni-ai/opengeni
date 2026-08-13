import { describe, expect, test } from "bun:test";
import { configuredModels, parseModelProvidersJson, resolveModelProvider } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { withXaiSubscriptionProvider } from "../src/activities/capabilities";

describe("withXaiSubscriptionProvider", () => {
  test("appends one metadata-only xAI subscription provider with namespaced models", () => {
    const settings = testSettings({ modelProvidersJson: "[]" });
    const result = withXaiSubscriptionProvider(settings);
    const providers = parseModelProvidersJson(result.modelProvidersJson);
    const xai = providers.find((provider) => provider.id === "supergrok-subscription");

    expect(xai).toBeDefined();
    expect(xai?.kind).toBe("xai-subscription");
    expect(xai?.api).toBe("responses");
    expect(xai?.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(xai?.models.length).toBeGreaterThan(0);
    expect(xai?.models.every((model) => model.id.startsWith("supergrok/"))).toBe(true);
    expect(
      xai?.models.every((model) => model.upstreamModelId === model.id.slice("supergrok/".length)),
    ).toBe(true);
    expect(JSON.stringify(xai)).not.toContain("bearer");
    expect(JSON.stringify(xai)).not.toContain("accountId");

    const configured = configuredModels(result).filter(
      (model) => model.providerId === "supergrok-subscription",
    );
    expect(configured.length).toBeGreaterThan(0);
    expect(
      configured.every(
        (model) =>
          model.hostedWebSearch === true &&
          model.capabilities.hostedTools.webSearch.upstream === "supported" &&
          model.capabilities.hostedTools.webSearch.runnable === true &&
          model.capabilities.hostedTools.xSearch.upstream === "supported" &&
          model.capabilities.hostedTools.xSearch.runnable === true,
      ),
    ).toBe(true);
  });

  test("resolves namespaced models to their upstream xAI slug", () => {
    const settings = withXaiSubscriptionProvider(testSettings({ modelProvidersJson: "[]" }));
    const model = configuredModels(settings).find(
      (candidate) => candidate.providerId === "supergrok-subscription",
    );
    expect(model).toBeDefined();

    const resolved = resolveModelProvider(settings, model!.id);
    expect(resolved?.provider.kind).toBe("xai-subscription");
    expect(resolved?.model.upstreamModelId).toBe(model!.id.slice("supergrok/".length));
  });

  test("preserves existing providers and is idempotent", () => {
    const existing = JSON.stringify([
      { id: "fireworks", baseUrl: "https://api.fireworks.ai", models: [{ id: "glm" }] },
    ]);
    const once = withXaiSubscriptionProvider(testSettings({ modelProvidersJson: existing }));
    const twice = withXaiSubscriptionProvider(once);
    const providers = parseModelProvidersJson(twice.modelProvidersJson);

    expect(twice).toBe(once);
    expect(providers.some((provider) => provider.id === "fireworks")).toBe(true);
    expect(providers.filter((provider) => provider.id === "supergrok-subscription")).toHaveLength(
      1,
    );
  });
});
