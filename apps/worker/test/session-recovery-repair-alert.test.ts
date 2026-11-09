import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS } from "@opengeni/core";
import {
  QUIESCENCE_REPAIR_CLOSE_GRACE_SECONDS,
  QUIESCENCE_REPAIR_WAKE_QUIET_SECONDS,
} from "@opengeni/db";
import { SESSION_RECOVERY_MONITOR_INTERVAL_MS } from "../src/observability-metrics";

async function source(path: string): Promise<string> {
  return await readFile(new URL(path, import.meta.url), "utf8");
}

function backlogStaleAlert(template: string): { thresholdSeconds: number; forSeconds: number } {
  const start = template.indexOf("        - alert: OpenGeniSessionRecoveryBacklogStale\n");
  expect(start).toBeGreaterThanOrEqual(0);
  const block = template.slice(start, template.indexOf("        - alert:", start + 1));
  const threshold = block.match(/\n\s+\) > (\d+)\n\s+for: (\d+)m\n/);
  if (!threshold) throw new Error("OpenGeniSessionRecoveryBacklogStale changed shape");
  return { thresholdSeconds: Number(threshold[1]), forSeconds: Number(threshold[2]) * 60 };
}

describe("durable recovery repair versus its critical alert", () => {
  test("the reaper repairs a missing quiescence receipt well before OpenGeniSessionRecoveryBacklogStale can fire", async () => {
    // The repair gate waits for Temporal's turn-activity lease: only an
    // expired lease lets the woken workflow prove the closing activity gone.
    const workflowActivities = await source("../src/workflows/activities.ts");
    const turnActivity = workflowActivities.match(
      /export function turnActivityForTaskQueue[\s\S]*?heartbeatTimeout: "(\d+) minutes"/,
    );
    if (!turnActivity) throw new Error("runAgentTurn heartbeat timeout changed shape");
    const heartbeatTimeoutSeconds = Number(turnActivity[1]) * 60;
    expect(QUIESCENCE_REPAIR_CLOSE_GRACE_SECONDS).toBeGreaterThanOrEqual(heartbeatTimeoutSeconds);

    // quiescence_missing is due at the attempt's close. A wake delivered after
    // the lease expired runs the reconciliation itself, so the stranding wake
    // precedes the close grace, and the reaper registers its repair wake no
    // later than one dispatcher period after close grace + quiet window.
    const worstRepairSeconds =
      QUIESCENCE_REPAIR_CLOSE_GRACE_SECONDS +
      QUIESCENCE_REPAIR_WAKE_QUIET_SECONDS +
      SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS / 1_000;
    // The overdue gauge falls only at the monitor's next read after the
    // repair; allow one more minute for scrape, rule evaluation and the woken
    // workflow's reconciliation.
    const worstClearSeconds =
      worstRepairSeconds + SESSION_RECOVERY_MONITOR_INTERVAL_MS / 1_000 + 60;

    // The alert needs the gauge above its threshold for its whole `for`.
    const alert = backlogStaleAlert(
      await source("../../../deploy/helm/opengeni/templates/prometheusrule.yaml"),
    );
    const earliestFireSeconds = alert.thresholdSeconds + alert.forSeconds;
    // Clearly, not barely: at least two more monitor reads of headroom.
    expect(
      worstClearSeconds + (2 * SESSION_RECOVERY_MONITOR_INTERVAL_MS) / 1_000,
    ).toBeLessThanOrEqual(earliestFireSeconds);
  });
});
