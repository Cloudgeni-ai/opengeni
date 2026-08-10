import { describe, expect, test } from "bun:test";
import {
  MIN_INSTANT_SERIES_REDUCTION,
  reductionRatio,
  retainedByProfile,
  TEMPORAL_MATCHING_METRICS,
} from "./bench-observability-series";

const values = Bun.YAML.parse(await Bun.file("deploy/observability/values.yaml").text())[
  "kube-prometheus-stack"
] as Record<string, any>;

describe("observability series projection", () => {
  test("retains Prometheus-generated scrape health outside metric relabeling", () => {
    expect(retainedByProfile("grafana", { __name__: "up" }, values)).toBe(true);
    expect(
      retainedByProfile(
        "prometheus-operator",
        { __name__: "scrape_samples_post_metric_relabeling" },
        values,
      ),
    ).toBe(true);
  });

  test("keeps only the logical Temporal backlog needed by the OpenGeni queue alert", () => {
    expect(TEMPORAL_MATCHING_METRICS).toEqual(
      new Set(["approximate_backlog_age_seconds", "approximate_backlog_count"]),
    );
    expect(
      retainedByProfile("temporal", { __name__: "approximate_backlog_age_seconds" }, values),
    ).toBe(true);
    expect(retainedByProfile("temporal", { __name__: "poll_latency_bucket" }, values)).toBe(false);
  });

  test("retains only the pod-reason exception consumed by the pinned mixin", () => {
    expect(
      retainedByProfile(
        "kube-state-metrics",
        { __name__: "kube_pod_status_reason", reason: "SchedulingGated" },
        values,
      ),
    ).toBe(true);
    expect(
      retainedByProfile(
        "kube-state-metrics",
        { __name__: "kube_pod_status_reason", reason: "Evicted" },
        values,
      ),
    ).toBe(false);
  });

  test("compares like-for-like instantaneous series instead of stale head state", () => {
    expect(MIN_INSTANT_SERIES_REDUCTION).toBe(4);
    expect(reductionRatio(80_000, 20_000)).toBe(4);
    expect(reductionRatio(80_000, 0)).toBe(0);
  });

  test("applies secondary-label bucket and interface drops", () => {
    expect(
      retainedByProfile(
        "kubernetes-api",
        { __name__: "apiserver_request_sli_duration_seconds_bucket", le: "1.0" },
        values,
      ),
    ).toBe(true);
    expect(
      retainedByProfile(
        "kubernetes-api",
        { __name__: "apiserver_request_sli_duration_seconds_bucket", le: "10.0" },
        values,
      ),
    ).toBe(false);
    expect(
      retainedByProfile(
        "kubelet",
        {
          __name__: "container_network_receive_bytes_total",
          metrics_path: "/metrics/cadvisor",
          interface: "cni0",
        },
        values,
      ),
    ).toBe(false);
  });
});
