import { expect, test } from "bun:test";
import {
  canonicalizeConfiguredModelId,
  configuredModels,
  configuredProviders,
  getSettings,
  resolveModelProvider,
  withCodexCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  withOrganizationGatewayCatalogProvider,
  withWorkspaceOpenRouterCatalogProvider,
  type Settings,
} from "../src";

// Exact former lookup algorithm, retained as a differential oracle.
function previousResolve(settings: Settings, modelId: string) {
  const canonicalModelId = canonicalizeConfiguredModelId(settings, modelId);
  const model = configuredModels(settings).find((candidate) => candidate.id === canonicalModelId);
  if (!model) return undefined;
  const provider = configuredProviders(settings).find(
    (candidate) => candidate.id === model.providerId,
  );
  return provider ? { provider, model } : undefined;
}

const registry = (upstream = "upstream-one") =>
  JSON.stringify([
    {
      id: "fixture",
      api: "chat",
      baseUrl: "https://model.example/v1",
      apiKey: "fixture-key",
      models: [{ id: "fixture/model", aliases: ["fixture-alias"], upstreamModelId: upstream }],
    },
  ]);

test("provider lookup constructs one catalog for canonical, alias and missing identities", () => {
  const settings = getSettings({ OPENGENI_ENV: "test", OPENGENI_MODEL_PROVIDERS_JSON: registry() });
  const allowed = settings.openaiAllowedModels;
  let reads = 0;
  Object.defineProperty(settings, "openaiAllowedModels", {
    get: () => {
      reads++;
      return allowed;
    },
  });
  for (const id of [settings.openaiModel, "fixture/model", "fixture-alias", "missing"]) {
    reads = 0;
    const actual = resolveModelProvider(settings, id);
    expect(reads).toBe(1);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(previousResolve(settings, id)));
  }
});

test("lookup observes changed settings and does not retain caller-mutated results", () => {
  const settings = getSettings({ OPENGENI_ENV: "test", OPENGENI_MODEL_PROVIDERS_JSON: registry() });
  const first = resolveModelProvider(settings, "fixture-alias")!;
  first.model.label = "caller mutation";
  first.provider.baseUrl = "https://mutated.example";
  expect(JSON.stringify(resolveModelProvider(settings, "fixture-alias"))).toBe(
    JSON.stringify(previousResolve(settings, "fixture-alias")),
  );
  settings.modelProvidersJson = registry("upstream-two");
  expect(resolveModelProvider(settings, "fixture-alias")?.model.upstreamModelId).toBe(
    "upstream-two",
  );
  settings.modelProvidersJson = "[]";
  expect(resolveModelProvider(settings, "fixture-alias")).toBeUndefined();
});

test("invalid catalogs fail with the same error details", () => {
  const settings = getSettings({ OPENGENI_ENV: "test" });
  const error = (run: () => unknown) => {
    try {
      run();
      return null;
    } catch (cause) {
      const e = cause as Error;
      return { name: e.name, message: e.message };
    }
  };
  for (const value of ["{", '[{"id":"fixture"}]']) {
    settings.modelProvidersJson = value;
    const expected = error(() => previousResolve(settings, "missing"));
    expect(expected).not.toBeNull();
    expect(error(() => resolveModelProvider(settings, "missing"))).toEqual(expected);
  }
});

test("built-in and subscription/custom overlays retain complete serialized lookup results", () => {
  const base = getSettings({ OPENGENI_ENV: "test" });
  const fixtures = [
    base,
    getSettings({
      OPENGENI_ENV: "test",
      OPENGENI_OPENAI_PROVIDER: "azure",
      OPENGENI_AZURE_OPENAI_BASE_URL: "https://fixture.openai.azure.com/openai/v1",
      OPENGENI_AZURE_OPENAI_API_KEY: "fixture-key",
    }),
    withCodexCatalogProvider({ ...base, codexSubscriptionEnabled: true }),
    withXaiSubscriptionCatalogProvider({ ...base, supergrokSubscriptionEnabled: true }),
    withOrganizationGatewayCatalogProvider(base, [
      { upstreamModelId: "fixture/custom", label: "Custom" },
    ]),
    withWorkspaceOpenRouterCatalogProvider(base),
  ];
  for (const settings of fixtures) {
    const ids = configuredModels(settings).flatMap((model) => [model.id, ...model.aliases]);
    for (const id of [...ids, "missing"]) {
      expect(JSON.stringify(resolveModelProvider(settings, id))).toBe(
        JSON.stringify(previousResolve(settings, id)),
      );
    }
  }
});

test("provider environment credentials remain fresh between lookups", () => {
  const key = `OPENGENI_TEST_PROVIDER_${crypto.randomUUID().replaceAll("-", "_")}`;
  const settings = getSettings({
    OPENGENI_ENV: "test",
    [key]: "fixture-initial",
    OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
      {
        id: "fixture",
        api: "chat",
        baseUrl: "https://model.example/v1",
        apiKeyEnv: key,
        models: [{ id: "fixture/model", aliases: ["fixture-alias"] }],
      },
    ]),
  });
  try {
    process.env[key] = "fixture-one";
    expect(resolveModelProvider(settings, "fixture-alias")?.provider.apiKey).toBe("fixture-one");
    process.env[key] = "fixture-two";
    expect(resolveModelProvider(settings, "fixture-alias")?.provider.apiKey).toBe("fixture-two");
    delete process.env[key];
    expect(resolveModelProvider(settings, "fixture-alias")?.provider.apiKey).toBeUndefined();
  } finally {
    delete process.env[key];
  }
});
