import { describe, expect, test } from "bun:test";
import {
  manualScheduledTaskTriggerUsageKey,
  manualScheduledTaskTriggerWorkflowId,
  scheduledTaskTriggerToken,
} from "@opengeni/core";

const WORKSPACE = "ws-1";
const TASK = "task-1";

describe("manual scheduled-task trigger idempotency token", () => {
  test("a client-supplied trigger id derives a stable token -> idempotent retry", () => {
    // A retried trigger that reuses the same token must produce the SAME usage
    // key AND the SAME workflowId, so the charge dedupes and the duplicate
    // workflow start is rejected -> one charge, one run.
    const token1 = scheduledTaskTriggerToken("my-stable-token");
    const token2 = scheduledTaskTriggerToken("my-stable-token");
    expect(token1).toBe(token2);
    expect(manualScheduledTaskTriggerUsageKey(WORKSPACE, TASK, token1)).toBe(
      manualScheduledTaskTriggerUsageKey(WORKSPACE, TASK, token2),
    );
    expect(manualScheduledTaskTriggerWorkflowId(TASK, token1)).toBe(
      manualScheduledTaskTriggerWorkflowId(TASK, token2),
    );
  });

  test("usage key and workflow id share the token so charge and run dedupe together", () => {
    const token = scheduledTaskTriggerToken("shared");
    expect(manualScheduledTaskTriggerUsageKey(WORKSPACE, TASK, token)).toContain(token);
    expect(manualScheduledTaskTriggerWorkflowId(TASK, token)).toContain(token);
  });

  test("absent trigger id mints a fresh token -> distinct triggers stay distinct", () => {
    // Two separate manual triggers with no client token are legitimately
    // different runs and must NOT collapse into one.
    const a = scheduledTaskTriggerToken();
    const b = scheduledTaskTriggerToken();
    expect(a).not.toBe(b);
    expect(manualScheduledTaskTriggerWorkflowId(TASK, a)).not.toBe(
      manualScheduledTaskTriggerWorkflowId(TASK, b),
    );
    expect(manualScheduledTaskTriggerUsageKey(WORKSPACE, TASK, a)).not.toBe(
      manualScheduledTaskTriggerUsageKey(WORKSPACE, TASK, b),
    );
  });

  test("blank / whitespace-only trigger id is treated as absent (fresh token)", () => {
    expect(scheduledTaskTriggerToken("")).not.toBe(scheduledTaskTriggerToken(""));
    expect(scheduledTaskTriggerToken("   ")).not.toBe(scheduledTaskTriggerToken("   "));
    expect(scheduledTaskTriggerToken(null)).not.toBe(scheduledTaskTriggerToken(undefined));
  });

  test("sanitizes a client token to the workflow-id-safe charset (no id-space smuggling)", () => {
    // A malicious or sloppy token cannot inject characters that would let it
    // collide with a DIFFERENT task's deterministic id or break Temporal's id.
    const token = scheduledTaskTriggerToken("../other-task/../evil id!");
    expect(token).toMatch(/^[a-zA-Z0-9._-]+$/);
    const workflowId = manualScheduledTaskTriggerWorkflowId(TASK, token);
    expect(workflowId.startsWith(`scheduled-task-${TASK}-manual-`)).toBe(true);
  });

  test("a non-empty token stays deterministic after sanitization (stable idempotency)", () => {
    // Disallowed chars are mapped to '_', not stripped, so a non-empty client
    // token always yields a non-empty, stable token: the same input gives the
    // same key on retry. (Only a blank/whitespace-only input mints fresh.)
    const a = scheduledTaskTriggerToken("///");
    const b = scheduledTaskTriggerToken("///");
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  test("clamps an overlong token so it cannot exceed Temporal id limits", () => {
    const token = scheduledTaskTriggerToken("x".repeat(500));
    expect(token.length).toBeLessThanOrEqual(128);
  });
});
