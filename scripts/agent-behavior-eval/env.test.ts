import { describe, expect, test } from "bun:test";

import { hasModelCredential, parseDotenv, selectModelEnv } from "./env";

describe("model env selection", () => {
  test("keeps OpenAI/Azure keys and the Gateway rail, drops everything else", () => {
    const env = selectModelEnv(
      parseDotenv(
        [
          "OPENGENI_OPENAI_API_KEY=a",
          "OPENGENI_AZURE_OPENAI_BASE_URL=b",
          "OPENGENI_VERCEL_AI_GATEWAY_API_KEY=c",
          "OPENGENI_GATEWAY_MODELS=kimi-k3",
          'OPENGENI_MANAGED_MODELS_JSON={"gatewayModels":[]}',
          "CLOUDGENI_GITHUB_TOKEN=never",
          "OPENGENI_DATABASE_URL=never",
        ].join("\n"),
      ),
    );
    expect(Object.keys(env).sort()).toEqual([
      "OPENGENI_AZURE_OPENAI_BASE_URL",
      "OPENGENI_GATEWAY_MODELS",
      "OPENGENI_MANAGED_MODELS_JSON",
      "OPENGENI_OPENAI_API_KEY",
      "OPENGENI_VERCEL_AI_GATEWAY_API_KEY",
    ]);
  });

  test("maps the shell-export Gateway key onto the OPENGENI_ name", () => {
    const env = selectModelEnv(parseDotenv("export VERCEL_AI_GATEWAY_API_KEY=k\nLINEAR_API_KEY=x"));
    expect(env).toEqual({ OPENGENI_VERCEL_AI_GATEWAY_API_KEY: "k" });
    expect(hasModelCredential(env)).toBe(true);
  });

  test("an explicit OPENGENI_ key wins over the alias", () => {
    const env = selectModelEnv(
      parseDotenv("VERCEL_AI_GATEWAY_API_KEY=alias\nOPENGENI_VERCEL_AI_GATEWAY_API_KEY=explicit"),
    );
    expect(env.OPENGENI_VERCEL_AI_GATEWAY_API_KEY).toBe("explicit");
  });

  test("Gateway-only env counts as a credential; empty env does not", () => {
    expect(hasModelCredential({ OPENGENI_VERCEL_AI_GATEWAY_API_KEY: "k" })).toBe(true);
    expect(hasModelCredential({ OPENGENI_GATEWAY_MODELS: "kimi-k3" })).toBe(false);
  });

  test("maps the localstack Azure pair onto the built-in Azure provider", () => {
    const env = selectModelEnv(
      parseDotenv(
        [
          "export AZURE_CLIENT_SECRET=never",
          "export F598_AZURE_OPENAI_API_KEY=k",
          "export F598_AZURE_OPENAI_BASE_URL=https://example.invalid/openai/v1",
        ].join("\n"),
      ),
    );
    expect(env).toEqual({
      OPENGENI_AZURE_OPENAI_API_KEY: "k",
      OPENGENI_AZURE_OPENAI_BASE_URL: "https://example.invalid/openai/v1",
      OPENGENI_OPENAI_PROVIDER: "azure",
    });
    expect(hasModelCredential(env)).toBe(true);
  });

  test("an explicit provider in the file is kept", () => {
    const env = selectModelEnv(
      parseDotenv("F598_AZURE_OPENAI_API_KEY=k\nOPENGENI_OPENAI_PROVIDER=openai"),
    );
    expect(env.OPENGENI_OPENAI_PROVIDER).toBe("openai");
  });
});
