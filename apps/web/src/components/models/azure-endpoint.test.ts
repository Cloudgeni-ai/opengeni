import { expect, test } from "bun:test";

import { readAzureOpenAIAddress } from "./azure-endpoint";

test("any address Azure shows for a resource reads as its Azure OpenAI endpoint", () => {
  for (const value of [
    "https://contoso.openai.azure.com",
    "https://contoso.openai.azure.com/",
    "https://contoso.openai.azure.com/openai/v1",
    " https://Contoso.cognitiveservices.azure.com/ ",
    "https://contoso.services.ai.azure.com/api/projects/demo",
  ]) {
    expect(readAzureOpenAIAddress(value)).toEqual({
      endpoint: "https://contoso.openai.azure.com",
    });
  }
});

test("a deployment's Target URI also names the deployment", () => {
  expect(
    readAzureOpenAIAddress(
      "https://contoso.cognitiveservices.azure.com/openai/deployments/gpt-6-sol/chat/completions?api-version=2025-01-01-preview",
    ),
  ).toEqual({ endpoint: "https://contoso.openai.azure.com", deployment: "gpt-6-sol" });
  expect(
    readAzureOpenAIAddress("https://contoso.openai.azure.com/openai/deployments/my%20model/"),
  ).toEqual({ endpoint: "https://contoso.openai.azure.com", deployment: "my model" });
});

test("anything else is not an Azure resource", () => {
  for (const value of [
    "",
    "contoso",
    "http://contoso.openai.azure.com",
    "https://contoso.openai.azure.com:8443",
    "https://user:pass@contoso.openai.azure.com",
    "https://proxy.example.com/openai/v1",
    "https://contoso.openai.azure.com.example.com",
  ]) {
    expect(readAzureOpenAIAddress(value)).toBeNull();
  }
});
