import { afterEach, describe, expect, test } from "bun:test";
import {
  configuredProviders,
  ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
  withOrganizationAzureOpenAICatalogProvider,
  withOrganizationAzureOpenAICredential,
} from "@opengeni/config";
import { testSettings } from "@opengeni/testing";

import {
  buildProviderClient,
  OrganizationAzureOpenAIUnavailableError,
} from "../src/model-provider";
import { requestBodyText } from "../src/replayable-json-body";

// Unique to this file so the process-wide client cache never shares a stub.
const ENDPOINT = "https://organization-azure-runtime.openai.azure.com/openai/v1";
const DEPLOYMENT = "gpt-6.1-sol";
const models = [{ upstreamModelId: DEPLOYMENT }];

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function organizationProvider(settings: ReturnType<typeof testSettings>) {
  return configuredProviders(settings).find(
    (candidate) => candidate.id === ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
  )!;
}

describe("organization Azure OpenAI runtime route", () => {
  test("calls <endpoint>/responses with the organization key as the api-key header", async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        headers: new Headers(init?.headers),
        body: JSON.parse(await requestBodyText(init?.body)),
      });
      return Response.json({
        id: "resp-1",
        object: "response",
        created_at: 0,
        status: "completed",
        model: DEPLOYMENT,
        output: [],
      });
    }) as typeof fetch;
    const settings = withOrganizationAzureOpenAICredential(
      testSettings({ openaiApiKey: "sk-deployment-must-not-leak" }),
      "azure-org-key",
      { endpoint: ENDPOINT, models },
    );
    const provider = organizationProvider(settings);
    expect(provider).toMatchObject({
      kind: "direct-azure-organization",
      api: "responses",
      wireProfile: "azure-openai",
      baseUrl: ENDPOINT,
    });
    const client = buildProviderClient(provider, settings);
    await client.responses.create({ model: DEPLOYMENT, input: "hello" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${ENDPOINT}/responses`);
    expect(calls[0]!.headers.get("api-key")).toBe("azure-org-key");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    expect(JSON.stringify([...calls[0]!.headers])).not.toContain("sk-deployment-must-not-leak");
    expect(calls[0]!.body.model).toBe(DEPLOYMENT);
  });

  test("a missing or revoked organization key fails closed before any request", () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    const settings = withOrganizationAzureOpenAICatalogProvider(
      testSettings({ openaiApiKey: "sk-deployment-fallback" }),
      { endpoint: ENDPOINT, models },
    );
    const provider = organizationProvider(settings);
    expect(provider.apiKey).toBeUndefined();
    expect(() => buildProviderClient(provider, settings)).toThrow(
      OrganizationAzureOpenAIUnavailableError,
    );
    expect(() => buildProviderClient({ ...provider, apiKey: "   " }, settings)).toThrow(
      OrganizationAzureOpenAIUnavailableError,
    );
    expect(requests).toBe(0);
  });
});
