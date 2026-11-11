import { deepStrictEqual } from "node:assert";
import {
  canonicalizeConfiguredModelId,
  configuredModels,
  configuredProviders,
  getSettings,
  resolveModelProvider,
  type Settings,
} from "@opengeni/config";

function previousResolve(settings: Settings, modelId: string) {
  const canonicalModelId = canonicalizeConfiguredModelId(settings, modelId);
  const model = configuredModels(settings).find((candidate) => candidate.id === canonicalModelId);
  if (!model) return undefined;
  const provider = configuredProviders(settings).find(
    (candidate) => candidate.id === model.providerId,
  );
  return provider ? { provider, model } : undefined;
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
for (const size of [1, 32, 128]) {
  const settings = getSettings({
    OPENGENI_ENV: "test",
    OPENGENI_MODEL_PROVIDERS_JSON: JSON.stringify([
      {
        id: "fixture",
        api: "chat",
        baseUrl: "https://model.example/v1",
        apiKey: "fixture-key",
        models: Array.from({ length: size }, (_, i) => ({
          id: `fixture/model-${i}`,
          aliases: [`alias-${i}`],
        })),
      },
    ]),
  });
  for (const id of [settings.openaiModel, `alias-${size - 1}`, "missing"]) {
    const samples = { base: [] as number[], candidate: [] as number[] };
    for (let pair = -5; pair < 40; pair++) {
      const results: unknown[] = [];
      const order =
        pair % 2 === 0 ? (["base", "candidate"] as const) : (["candidate", "base"] as const);
      for (const side of order) {
        const start = performance.now();
        const value =
          side === "base" ? previousResolve(settings, id) : resolveModelProvider(settings, id);
        const elapsed = performance.now() - start;
        if (pair >= 0) samples[side].push(elapsed);
        results.push(value);
      }
      deepStrictEqual(results[0], results[1]);
    }
    console.log(
      JSON.stringify({
        registryModels: size,
        id,
        pairs: 40,
        baseMs: median(samples.base),
        candidateMs: median(samples.candidate),
      }),
    );
  }
}
