import { describe, expect, test } from "bun:test";
import type { Observability } from "@opengeni/observability";
import { workspaceDeleteObserver } from "../src/workspace-delete-observability";

describe("workspace delete observability", () => {
  test("records bounded metrics and exact identifiers only in structured logs", () => {
    const histograms: Array<Record<string, unknown>> = [];
    const counters: Array<Record<string, unknown>> = [];
    const logs: Array<{ message: string; attributes: Record<string, unknown> }> = [];
    const observability = {
      observeHistogram: (input: Record<string, unknown>) => histograms.push(input),
      incrementCounter: (input: Record<string, unknown>) => counters.push(input),
      info: (message: string, attributes: Record<string, unknown>) =>
        logs.push({ message, attributes }),
    } as unknown as Observability;

    const observer = workspaceDeleteObserver(observability, {
      accountId: "account-id",
      workspaceId: "workspace-id",
    });
    observer?.onPhase?.({
      phase: "transaction",
      outcome: "deleted",
      durationSeconds: 2_001,
      inventory: { sessions: 123, temporal_schedules: 2 },
    });

    expect(histograms.map((entry) => entry.name)).toEqual([
      "opengeni_workspace_delete_phase_seconds",
      "opengeni_workspace_delete_inventory_rows",
      "opengeni_workspace_delete_inventory_rows",
    ]);
    expect(histograms[0]?.labels).toEqual({ phase: "transaction", outcome: "deleted" });
    expect(JSON.stringify(histograms)).not.toContain("workspace-id");
    expect(counters).toEqual([
      expect.objectContaining({
        name: "opengeni_workspace_delete_attempts_total",
        labels: { outcome: "deleted" },
      }),
    ]);
    expect(logs).toEqual([
      {
        message: "Workspace deletion phase",
        attributes: expect.objectContaining({
          accountId: "account-id",
          workspaceId: "workspace-id",
          durationSeconds: 2_001,
          inventoryJson: JSON.stringify({ sessions: 123, temporal_schedules: 2 }),
        }),
      },
    ]);
  });

  test("isolates a failing observability sink", () => {
    let observerErrors = 0;
    const observability = {
      observeHistogram: () => {
        throw new Error("registry unavailable");
      },
      incrementCounter: (input: { labels?: { observer?: string } }) => {
        if (input.labels?.observer === "workspace_delete") observerErrors += 1;
      },
      info: () => undefined,
    } as unknown as Observability;
    expect(() =>
      workspaceDeleteObserver(observability, {
        accountId: "account-id",
        workspaceId: "workspace-id",
      })?.onPhase?.({ phase: "cascade", outcome: "deleted", durationSeconds: 1 }),
    ).not.toThrow();
    expect(observerErrors).toBe(1);
  });
});
