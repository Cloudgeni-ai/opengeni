import { describe, expect, test } from "bun:test";

import { renderTemporalValues } from "./deployment-temporal-values";

const requiredEnv = {
  TEMPORAL_POSTGRES_HOST: "postgres.example.internal",
};

describe("renderTemporalValues", () => {
  test("renders byte-bounded history cache and Go/container memory headroom", () => {
    const values = Bun.YAML.parse(renderTemporalValues(requiredEnv)) as Record<string, any>;

    expect(values.server.dynamicConfig).toEqual({
      "history.cacheSizeBasedLimit": [{ value: true, constraints: {} }],
      "history.hostLevelCacheMaxSizeBytes": [{ value: 134_217_728, constraints: {} }],
      "history.cacheTTL": [{ value: "10m", constraints: {} }],
      "history.cacheBackgroundEvict": [
        {
          value: {
            Enabled: true,
            LoopInterval: "1m",
            MaxEntryPerCall: 4096,
          },
          constraints: {},
        },
      ],
      "history.enableHostLevelEventsCache": [{ value: true, constraints: {} }],
      "history.eventsHostLevelCacheMaxSizeBytes": [{ value: 67_108_864, constraints: {} }],
      "history.eventsCacheTTL": [{ value: "10m", constraints: {} }],
    });
    expect(values.server.history).toEqual({
      resources: {
        requests: { memory: "768Mi" },
        limits: { memory: "1280Mi" },
      },
      additionalEnv: [{ name: "GOMEMLIMIT", value: "768MiB" }],
    });
    expect(values.admintools).toEqual({ enabled: false });
    expect(values.server.metrics.serviceMonitor).toEqual({
      enabled: false,
      interval: "30s",
      additionalLabels: { "opengeni.ai/monitoring": "enabled" },
      metricRelabelings: [
        {
          action: "drop",
          sourceLabels: ["__name__"],
          regex: ".*latency.*_bucket",
        },
      ],
    });
  });

  test("supports explicit memory tuning without changing cache semantics", () => {
    const values = Bun.YAML.parse(
      renderTemporalValues({
        ...requiredEnv,
        TEMPORAL_HISTORY_CACHE_MAX_BYTES: "402653184",
        TEMPORAL_HISTORY_CACHE_TTL: "15m",
        TEMPORAL_EVENTS_CACHE_MAX_BYTES: "100663296",
        TEMPORAL_EVENTS_CACHE_TTL: "20m",
        TEMPORAL_HISTORY_GOMEMLIMIT: "1280MiB",
        TEMPORAL_HISTORY_MEMORY_REQUEST: "768Mi",
        TEMPORAL_HISTORY_MEMORY_LIMIT: "2Gi",
        TEMPORAL_SERVICE_MONITOR_ENABLED: "true",
      }),
    ) as Record<string, any>;

    expect(values.server.dynamicConfig["history.hostLevelCacheMaxSizeBytes"][0].value).toBe(
      402_653_184,
    );
    expect(values.server.dynamicConfig["history.cacheTTL"][0].value).toBe("15m");
    expect(values.server.dynamicConfig["history.eventsHostLevelCacheMaxSizeBytes"][0].value).toBe(
      100_663_296,
    );
    expect(values.server.dynamicConfig["history.eventsCacheTTL"][0].value).toBe("20m");
    expect(values.server.history.resources).toEqual({
      requests: { memory: "768Mi" },
      limits: { memory: "2Gi" },
    });
    expect(values.server.history.additionalEnv[0].value).toBe("1280MiB");
    expect(values.server.metrics.serviceMonitor.enabled).toBe(true);
  });

  test("rejects malformed cache and memory settings", () => {
    expect(() =>
      renderTemporalValues({
        ...requiredEnv,
        TEMPORAL_HISTORY_CACHE_MAX_BYTES: "0",
      }),
    ).toThrow("TEMPORAL_HISTORY_CACHE_MAX_BYTES must be a positive integer");
    expect(() =>
      renderTemporalValues({
        ...requiredEnv,
        TEMPORAL_HISTORY_CACHE_TTL: "forever",
      }),
    ).toThrow("TEMPORAL_HISTORY_CACHE_TTL must be a positive duration");
    expect(() =>
      renderTemporalValues({
        ...requiredEnv,
        TEMPORAL_EVENTS_CACHE_MAX_BYTES: "0",
      }),
    ).toThrow("TEMPORAL_EVENTS_CACHE_MAX_BYTES must be a positive integer");
    expect(() =>
      renderTemporalValues({
        ...requiredEnv,
        TEMPORAL_HISTORY_GOMEMLIMIT: "1.2GiB",
      }),
    ).toThrow("TEMPORAL_HISTORY_GOMEMLIMIT must be a positive Go memory limit");
    expect(() =>
      renderTemporalValues({
        ...requiredEnv,
        TEMPORAL_HISTORY_MEMORY_LIMIT: "large",
      }),
    ).toThrow("TEMPORAL_HISTORY_MEMORY_LIMIT must be a positive Kubernetes memory quantity");
  });
});
