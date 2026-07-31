import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  isUsableVoiceInputSecret,
  resolveVoiceInputProviderRegistry,
  voiceInputDeploymentConfigured,
} from "../src";

describe("voice input provider registry", () => {
  test("selects openai when an API key is present and Codex is off", () => {
    const providers = resolveVoiceInputProviderRegistry(testSettings());
    expect(providers.map((provider) => provider.id)).toEqual(["openai"]);
    expect(voiceInputDeploymentConfigured(testSettings())).toBe(true);
  });

  test("ignores template placeholder OpenAI keys", () => {
    expect(isUsableVoiceInputSecret("your-key")).toBe(false);
    expect(
      resolveVoiceInputProviderRegistry(
        testSettings({
          openaiApiKey: "your-key",
          productAccessMode: "configured",
          codexSubscriptionEnabled: false,
        }),
      ),
    ).toEqual([]);
  });

  test("selects azure when turn provider is azure and deployment is complete", () => {
    const providers = resolveVoiceInputProviderRegistry(
      testSettings({
        openaiProvider: "azure",
        openaiApiKey: undefined,
        azureOpenaiEndpoint: "https://example.openai.azure.com",
        azureOpenaiDeployment: "gpt-transcribe",
        azureOpenaiApiVersion: "2025-04-01-preview",
        azureOpenaiApiKey: "azure-key",
      }),
    );
    expect(providers.map((provider) => provider.id)).toEqual(["azure-openai"]);
  });

  test("prefers Codex ahead of OpenAI when subscription routing is enabled", () => {
    expect(
      resolveVoiceInputProviderRegistry(
        testSettings({
          codexSubscriptionEnabled: true,
          voiceInputCodexExperimentalEnabled: false,
          voiceInputProviderOrder: "codex-subscription,openai,azure-openai",
        }),
      ).map((provider) => provider.id),
    ).toEqual(["codex-subscription", "openai"]);
  });

  test("includes Codex when subscription is enabled without the experimental flag", () => {
    expect(
      resolveVoiceInputProviderRegistry(
        testSettings({
          openaiApiKey: undefined,
          voiceInputCodexExperimentalEnabled: false,
          codexSubscriptionEnabled: true,
          voiceInputProviderOrder: "codex-subscription,openai,azure-openai",
        }),
      ).map((provider) => provider.id),
    ).toEqual(["codex-subscription"]);
    expect(
      voiceInputDeploymentConfigured(
        testSettings({
          openaiApiKey: undefined,
          voiceInputCodexExperimentalEnabled: false,
          codexSubscriptionEnabled: true,
        }),
      ),
    ).toBe(false);
  });

  test("does not include Codex when subscription routing is disabled", () => {
    expect(
      resolveVoiceInputProviderRegistry(
        testSettings({
          openaiApiKey: "your-key",
          productAccessMode: "local",
          codexSubscriptionEnabled: false,
          voiceInputCodexExperimentalEnabled: true,
          voiceInputProviderOrder: "codex-subscription,openai,azure-openai",
        }),
      ).map((provider) => provider.id),
    ).toEqual([]);
  });

  test("honors explicit OpenAI-first provider order", () => {
    const providers = resolveVoiceInputProviderRegistry(
      testSettings({
        codexSubscriptionEnabled: true,
        voiceInputProviderOrder: "openai,azure-openai,codex-subscription",
      }),
    );
    expect(providers.map((provider) => provider.id)).toEqual([
      "openai",
      "codex-subscription",
    ]);
  });

  test("honors provider order and skips disabled openai", () => {
    const providers = resolveVoiceInputProviderRegistry(
      testSettings({
        voiceInputOpenaiEnabled: false,
        voiceInputAzureEndpoint: "https://example.openai.azure.com",
        voiceInputAzureDeployment: "transcribe",
        voiceInputAzureApiKey: "azure-key",
        voiceInputProviderOrder: "azure-openai,openai",
      }),
    );
    expect(providers.map((provider) => provider.id)).toEqual(["azure-openai"]);
  });
});
