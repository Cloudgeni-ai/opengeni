import { describe, expect, test } from "bun:test";
import { resolveModelProvider } from "@opengeni/config";
import { canonicalConfiguredModel } from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import { HTTPException } from "hono/http-exception";

function stagingAzureSettings() {
  return testSettings({
    openaiProvider: "azure",
    openaiModel: "gpt-5.5",
    openaiAllowedModels: "gpt-5.5",
    azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
    azureOpenaiDeployment: "gpt-5.5",
    azureOpenaiApiKey: "azure-test-key",
  });
}

describe("Azure application model admission", () => {
  test("admits the configured product model and binds it to the Azure deployment", () => {
    const settings = stagingAzureSettings();

    expect(canonicalConfiguredModel(settings, "gpt-5.5")).toBe("gpt-5.5");
    expect(resolveModelProvider(settings, "gpt-5.5")).toMatchObject({
      provider: { id: "azure", builtin: true, api: "responses" },
      model: {
        id: "gpt-5.5",
        upstreamModelId: "gpt-5.5",
        deployment: { upstreamModelId: "gpt-5.5", wireApi: "responses" },
      },
    });
  });

  test("still rejects a model outside the configured Azure catalog", () => {
    const settings = stagingAzureSettings();
    let thrown: unknown;

    try {
      canonicalConfiguredModel(settings, "gpt-5.6-sol");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HTTPException);
    expect((thrown as HTTPException).status).toBe(422);
    expect((thrown as HTTPException).message).toBe("model is not available: gpt-5.6-sol");
    expect(resolveModelProvider(settings, "gpt-5.6-sol")).toBeUndefined();
  });
});
