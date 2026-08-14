import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { recordOpenSandboxKubernetesInventoryGauges } from "../src/observability-metrics";
import {
  inspectOpenSandboxKubernetesInventory,
  type KubernetesJsonRequest,
} from "../src/opensandbox-kubernetes-inventory";

const NOW = Date.parse("2026-08-14T17:30:00.000Z");

describe("OpenSandbox Kubernetes inventory", () => {
  test("aggregates 500 opaque resources into a constant bounded metric surface", async () => {
    const batchSandboxes = Array.from({ length: 500 }, (_, index) => ({
      metadata: {
        name: opaqueId(index),
        ...(index === 0
          ? {
              deletionTimestamp: "2026-08-14T17:20:00.000Z",
              finalizers: ["sandbox.opensandbox.io/finalizer"],
            }
          : {}),
      },
      spec: {
        expireTime: index === 1 ? "2026-08-14T17:20:00.000Z" : "2026-08-14T18:30:00.000Z",
      },
      status: {
        phase: ["Pending", "Succeed", "Pausing", "Paused", "Resuming", "Failed"][index % 6],
      },
    }));
    const pods = Array.from({ length: 500 }, (_, index) => ({
      metadata: { name: opaqueId(index + 1_000) },
      status: {
        phase: index % 10 === 0 ? "Pending" : "Running",
        ...(index % 20 === 0
          ? {
              containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }],
            }
          : {}),
        ...(index % 25 === 0
          ? {
              conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }],
            }
          : {}),
      },
    }));
    const requested: URL[] = [];
    const requestJson = pagedRequest(batchSandboxes, pods, requested);

    const inventory = await inspectOpenSandboxKubernetesInventory({
      namespace: "opensandbox",
      nowMs: NOW,
      requestJson,
    });

    expect(Object.values(inventory.batchSandboxPhases).reduce((sum, value) => sum + value, 0)).toBe(
      500,
    );
    expect(inventory.workloadPodConditions).toEqual({
      pending: 50,
      image_pull: 25,
      unschedulable: 20,
    });
    expect(inventory.cleanupStuck).toBe(1);
    expect(inventory.expirationOverdue).toBe(1);
    expect(requested.some((url) => url.searchParams.get("continue") === "200")).toBe(true);
    expect(
      requested
        .filter((url) => url.pathname.endsWith("/pods"))
        .every((url) => url.searchParams.get("labelSelector") === "opensandbox.io/id"),
    ).toBe(true);

    const observability = createObservability(testSettings(), { component: "worker-test" });
    recordOpenSandboxKubernetesInventoryGauges(observability, inventory);
    const metrics = await observability.prometheusMetrics();
    const samples = metrics
      .split("\n")
      .filter((line) =>
        /^opengeni_opensandbox_(?:batchsandboxes|workload_pods|cleanup_stuck|expiration_overdue)(?:\{|\s)/.test(
          line,
        ),
      );
    expect(samples).toHaveLength(12);
    expect(metrics).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4000-8000-[0-9a-f]{12}/);
    expect(metrics).not.toMatch(/sandbox_id|pod=|batchsandbox=/);
  });

  test("ignores deleting Pods and rejects unsafe namespaces before any request", async () => {
    let requests = 0;
    const requestJson: KubernetesJsonRequest = async (url) => {
      requests += 1;
      return url.pathname.endsWith("/pods")
        ? {
            items: [
              {
                metadata: { deletionTimestamp: "2026-08-14T17:29:00.000Z" },
                status: {
                  phase: "Pending",
                  containerStatuses: [{ state: { waiting: { reason: "ErrImagePull" } } }],
                  conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }],
                },
              },
            ],
            metadata: {},
          }
        : { items: [], metadata: {} };
    };
    const inventory = await inspectOpenSandboxKubernetesInventory({
      namespace: "opensandbox",
      nowMs: NOW,
      requestJson,
    });
    expect(inventory.workloadPodConditions).toEqual({
      pending: 0,
      image_pull: 0,
      unschedulable: 0,
    });
    expect(requests).toBe(2);

    await expect(
      inspectOpenSandboxKubernetesInventory({ namespace: "../secrets", requestJson }),
    ).rejects.toThrow("namespace is invalid");
    expect(requests).toBe(2);
  });
});

function pagedRequest(
  batchSandboxes: unknown[],
  pods: unknown[],
  requested: URL[],
): KubernetesJsonRequest {
  return async (url) => {
    requested.push(new URL(url));
    const values = url.pathname.endsWith("/pods") ? pods : batchSandboxes;
    const offset = Number(url.searchParams.get("continue") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "200");
    const items = values.slice(offset, offset + limit);
    const next = offset + items.length < values.length ? String(offset + items.length) : "";
    return { items, metadata: { continue: next } };
  };
}

function opaqueId(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index
    .toString(16)
    .padStart(12, "0")}`;
}
