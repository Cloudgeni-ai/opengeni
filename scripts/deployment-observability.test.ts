import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { observabilityStackPlanFor } from "./deployment-observability";

describe("observability deployment plan", () => {
  test("keeps every bundled platform ServiceMonitor inside canonical discovery", () => {
    const values = Bun.YAML.parse(readFileSync("deploy/observability/values.yaml", "utf8"));

    expect(
      values["kube-prometheus-stack"].grafana.serviceMonitor.labels["opengeni.ai/monitoring"],
    ).toBe("enabled");
    expect(
      values["kube-prometheus-stack"]["kube-state-metrics"].prometheus.monitor.additionalLabels[
        "opengeni.ai/monitoring"
      ],
    ).toBe("enabled");
    expect(
      values["kube-prometheus-stack"]["prometheus-node-exporter"].prometheus.monitor
        .additionalLabels["opengeni.ai/monitoring"],
    ).toBe("enabled");
  });

  test("renders a pinned, ordered production plan", () => {
    const plan = observabilityStackPlanFor({
      profile: "production",
      environment: "prod-us",
    });

    expect(plan.chartPath).toBe("deploy/observability");
    expect(plan.chartVersion).toBe("0.1.4");
    expect(plan.kubePrometheusStackVersion).toBe("87.16.1");
    expect(plan.valuesFiles).toEqual(["deploy/observability/values.production.example.yaml"]);
    expect(plan.installCommands.slice(0, 2)).toEqual([
      "helm repo add prometheus-community https://prometheus-community.github.io/helm-charts",
      "helm dependency build deploy/observability",
    ]);
    expect(
      plan.installCommands.filter((command) => command.includes("kubectl label namespace")),
    ).toEqual([
      "kubectl label namespace observability opengeni.ai/monitoring=enabled --overwrite",
      "kubectl label namespace opengeni opengeni.ai/monitoring=enabled --overwrite",
    ]);
    expect(
      plan.installCommands.some(
        (command) =>
          command.includes("helm upgrade --install opengeni-observability") &&
          command.includes("environment=prod-us"),
      ),
    ).toBe(true);
    expect(
      plan.installCommands.some((command) =>
        command.includes("grafana.podAnnotations.opengeni\\.ai/source-revision="),
      ),
    ).toBe(true);
    expect(plan.installCommands.some((command) => command.includes("deploy/helm/opengeni"))).toBe(
      false,
    );
    expect(plan.verifyCommands[0]).toContain("deployment:observability-verify");
    expect(plan.destroyCommands).toEqual([
      "helm uninstall opengeni-observability --namespace observability --ignore-not-found",
    ]);
    expect(plan.notes.some((note) => note.includes("never runs application hooks"))).toBe(true);
  });

  test("rejects unsupported profiles and shell-unsafe identifiers", () => {
    expect(() => observabilityStackPlanFor({ namespace: "observability;rm" })).toThrow();
    expect(() => observabilityStackPlanFor({ environment: "prod $(id)" })).toThrow();
    expect(() => observabilityStackPlanFor({ profile: "preview" as "single-node" })).toThrow();
  });
});
