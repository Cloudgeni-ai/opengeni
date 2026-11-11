import { describe, expect, test } from "bun:test";

import { renderTemporalValues } from "./deployment-temporal-values";

const requiredEnv = {
  TEMPORAL_POSTGRES_HOST: "postgres.example.internal",
};

const defaultResources = {
  frontend: {
    requests: { cpu: "200m", memory: "256Mi" },
    limits: { cpu: "1", memory: "512Mi" },
  },
  history: {
    requests: { cpu: "250m", memory: "768Mi" },
    limits: { cpu: "1", memory: "1280Mi" },
  },
  matching: {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  },
  worker: {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  },
};

describe("renderTemporalValues", () => {
  test("keeps the committed upstream example resource envelopes aligned with generator defaults", async () => {
    const example = Bun.YAML.parse(
      await Bun.file(
        new URL("../deploy/stacks/official-temporal-postgres.values.example.yaml", import.meta.url),
      ).text(),
    ) as Record<string, any>;
    const generated = Bun.YAML.parse(renderTemporalValues(requiredEnv)) as Record<string, any>;

    for (const role of Object.keys(defaultResources)) {
      expect(example.server[role]?.resources).toEqual(generated.server[role].resources);
    }
  });

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
      resources: defaultResources.history,
      additionalEnv: [{ name: "GOMEMLIMIT", value: "768MiB" }],
    });
    for (const [role, resources] of Object.entries(defaultResources)) {
      expect(values.server[role].resources).toEqual(resources);
      expect(values.server[role].replicaCount).toBeUndefined();
    }
    expect(values.server.replicaCount).toBe(1);
    for (const store of ["default", "visibility"]) {
      expect(values.server.config.persistence.datastores[store].sql).toMatchObject({
        maxConns: 20,
        maxIdleConns: 20,
        maxConnLifetime: "1h",
      });
    }
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
      requests: { cpu: "250m", memory: "768Mi" },
      limits: { cpu: "1", memory: "2Gi" },
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

  test("supports the staging history envelope without altering other roles or cache controls", () => {
    const defaults = Bun.YAML.parse(renderTemporalValues(requiredEnv)) as Record<string, any>;
    const values = Bun.YAML.parse(
      renderTemporalValues({
        ...requiredEnv,
        TEMPORAL_HISTORY_CPU_REQUEST: "500m",
        TEMPORAL_HISTORY_MEMORY_REQUEST: "3Gi",
        TEMPORAL_HISTORY_CPU_LIMIT: "1",
        TEMPORAL_HISTORY_MEMORY_LIMIT: "4Gi",
      }),
    ) as Record<string, any>;

    expect(values.server.history.resources).toEqual({
      requests: { cpu: "500m", memory: "3Gi" },
      limits: { cpu: "1", memory: "4Gi" },
    });
    expect(values.server.history.additionalEnv).toEqual(defaults.server.history.additionalEnv);
    expect(values.server.dynamicConfig).toEqual(defaults.server.dynamicConfig);
    for (const role of ["frontend", "matching", "worker"]) {
      expect(values.server[role]).toEqual(defaults.server[role]);
    }
  });

  for (const role of Object.keys(defaultResources)) {
    const prefix = `TEMPORAL_${role.toUpperCase()}`;

    test(`supports independent ${role} CPU and memory overrides`, () => {
      const values = Bun.YAML.parse(
        renderTemporalValues({
          ...requiredEnv,
          [`${prefix}_CPU_REQUEST`]: " 0.5 ",
          [`${prefix}_MEMORY_REQUEST`]: " 1Gi ",
          [`${prefix}_CPU_LIMIT`]: "1.5",
          [`${prefix}_MEMORY_LIMIT`]: "2Gi",
        }),
      ) as Record<string, any>;
      expect(values.server[role].resources).toEqual({
        requests: { cpu: "0.5", memory: "1Gi" },
        limits: { cpu: "1.5", memory: "2Gi" },
      });
      for (const [otherRole, resources] of Object.entries(defaultResources)) {
        if (otherRole !== role) expect(values.server[otherRole].resources).toEqual(resources);
      }
    });

    test(`rejects malformed ${role} resource quantities`, () => {
      for (const suffix of ["REQUEST", "LIMIT"]) {
        const cpuName = `${prefix}_CPU_${suffix}`;
        for (const value of [
          "0",
          "0m",
          "0.000",
          "-1",
          "0.0001",
          "0.5m",
          "1.0000",
          "NaN",
          "1Gi",
          "1\nother: true",
        ]) {
          expect(() => renderTemporalValues({ ...requiredEnv, [cpuName]: value })).toThrow(
            `${cpuName} must be a positive Kubernetes CPU quantity`,
          );
        }
        const memoryName = `${prefix}_MEMORY_${suffix}`;
        for (const value of [
          "0Mi",
          "-1Gi",
          "1.5Gi",
          "1GiB",
          "512m",
          "1K",
          "large",
          "1Gi\nother: true",
        ]) {
          expect(() => renderTemporalValues({ ...requiredEnv, [memoryName]: value })).toThrow(
            `${memoryName} must be a positive Kubernetes memory quantity`,
          );
        }
      }
    });

    test(`compares ${role} requests and limits across quantity units`, () => {
      const cpuRequest = `${prefix}_CPU_REQUEST`;
      const cpuLimit = `${prefix}_CPU_LIMIT`;
      const memoryRequest = `${prefix}_MEMORY_REQUEST`;
      const memoryLimit = `${prefix}_MEMORY_LIMIT`;
      expect(() =>
        renderTemporalValues({
          ...requiredEnv,
          [cpuRequest]: "1001m",
          [cpuLimit]: "1",
        }),
      ).toThrow(`${cpuRequest} must not exceed ${cpuLimit}`);
      expect(() =>
        renderTemporalValues({
          ...requiredEnv,
          [memoryRequest]: "1Gi",
          [memoryLimit]: "1000M",
        }),
      ).toThrow(`${memoryRequest} must not exceed ${memoryLimit}`);
      expect(() =>
        renderTemporalValues({
          ...requiredEnv,
          [cpuRequest]: "1000m",
          [cpuLimit]: "1.000",
          [memoryRequest]: "1024Mi",
          [memoryLimit]: "1Gi",
        }),
      ).not.toThrow();
      expect(() =>
        renderTemporalValues({
          ...requiredEnv,
          [cpuRequest]: "0.001",
          [memoryRequest]: "1000M",
          [memoryLimit]: "1Gi",
        }),
      ).not.toThrow();
      expect(() =>
        renderTemporalValues({
          ...requiredEnv,
          [memoryRequest]: "1k",
          [memoryLimit]: "1Ki",
        }),
      ).not.toThrow();
    });
  }
});
