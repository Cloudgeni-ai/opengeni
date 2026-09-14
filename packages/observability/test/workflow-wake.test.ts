import { expect, test } from "bun:test";
import { createObservability, recordWorkflowWakeReconciliation } from "../src";

const settings = {
  serviceName: "opengeni",
  environment: "test",
  observabilityStructuredLogs: true,
  observabilityMetricsEnabled: true,
};

test("wake transport acceptance and pending admission survive the public log sink separately", async () => {
  const obs = createObservability(settings, { component: "worker-control" });
  const logs: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => logs.push(String(message));
  try {
    recordWorkflowWakeReconciliation(obs, {
      signaled: 5,
      delivered: 1,
      pendingAdmission: 3,
      unconfirmed: 1,
      failed: 0,
      pendingAdmissionBlockers: { pending_prompt_turn: 2, pending_quiescence: 1 },
    });
  } finally {
    console.log = original;
  }
  const parsed = logs.map((line) => JSON.parse(line));
  expect(parsed).toContainEqual(
    expect.objectContaining({ outcome: "signal_accepted", attempts: 5 }),
  );
  expect(parsed).toContainEqual(expect.objectContaining({ outcome: "acknowledged", attempts: 1 }));
  expect(parsed).toContainEqual(
    expect.objectContaining({ outcome: "pending_admission", attempts: 3 }),
  );
  expect(parsed).toContainEqual(
    expect.objectContaining({ reason: "pending_prompt_turn", attempts: 2 }),
  );
  expect(parsed).toContainEqual(
    expect.objectContaining({ reason: "pending_quiescence", attempts: 1 }),
  );
  const metrics = await obs.prometheusMetrics();
  expect(metrics).toMatch(
    /opengeni_session_workflow_wake_observations_total\{[^\n]*outcome="signal_accepted"[^\n]*\} 5/,
  );
  expect(metrics).toMatch(
    /opengeni_session_workflow_wake_observations_total\{[^\n]*outcome="acknowledged"[^\n]*\} 1/,
  );
  expect(metrics).toMatch(
    /opengeni_session_workflow_wake_admission_blockers_total\{[^\n]*reason="pending_prompt_turn"[^\n]*\} 2/,
  );
});

test("unreviewed blocker names cannot create arbitrary public series or log values", async () => {
  const obs = createObservability(settings, { component: "worker-control" });
  const logs: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => logs.push(String(message));
  try {
    recordWorkflowWakeReconciliation(obs, {
      signaled: NaN,
      delivered: -1,
      pendingAdmission: 1,
      unconfirmed: Infinity,
      failed: 0,
      pendingAdmissionBlockers: { "unreviewed-tenant-content": 1, pending_input_wait: NaN },
    });
  } finally {
    console.log = original;
  }
  const metrics = await obs.prometheusMetrics();
  expect(metrics).not.toContain("unreviewed-tenant-content");
  expect(logs.join("\n")).not.toContain("unreviewed-tenant-content");
  expect(metrics).toContain('reason="unknown"');
  expect(metrics).toMatch(
    /opengeni_session_workflow_wake_admission_blockers_total\{[^\n]*reason="pending_input_wait"[^\n]*\} 0/,
  );
  expect(logs.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({ reason: "unknown", attempts: 1 }),
  );
});

test("real worker components publish zero baselines before the first failure or wake", async () => {
  for (const component of ["worker", "worker-control", "worker-turn", "api"]) {
    const obs = createObservability(settings, { component });
    const metrics = await obs.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_materialization_verification_failures_total\{[^\n]*\} 0/,
    );
    if (component === "worker" || component === "worker-control") {
      for (const outcome of [
        "signal_accepted",
        "acknowledged",
        "pending_admission",
        "unconfirmed",
        "failed",
      ]) {
        expect(metrics).toMatch(
          new RegExp(
            `opengeni_session_workflow_wake_observations_total\\{[^\\n]*outcome="${outcome}"[^\\n]*\\} 0`,
          ),
        );
      }
      for (const reason of [
        "pending_agent_steer",
        "pending_prompt_turn",
        "pending_quiescence",
        "pending_machine_input",
        "pending_input_wait",
        "unknown",
      ]) {
        expect(metrics).toMatch(
          new RegExp(
            `opengeni_session_workflow_wake_admission_blockers_total\\{[^\\n]*reason="${reason}"[^\\n]*\\} 0`,
          ),
        );
      }
    }
  }
});

test("telemetry failure cannot fail a completed wake reconciliation", () => {
  const obs = createObservability(settings, { component: "worker-control" });
  obs.incrementCounter = () => {
    throw new Error("metrics unavailable");
  };
  expect(() =>
    recordWorkflowWakeReconciliation(obs, {
      signaled: 1,
      delivered: 1,
      pendingAdmission: 0,
      unconfirmed: 0,
      failed: 0,
      pendingAdmissionBlockers: {},
    }),
  ).not.toThrow();
});
