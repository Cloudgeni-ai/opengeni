import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  initializeContextCompactionMetrics,
  ModelRequestLifecycleMetrics,
  recordBatchFlush,
  recordContextCompaction,
  recordContextCompactionStarted,
  recordCompanyBrainContributions,
  recordModelInputTokens,
  recordModelRequestPhase,
  recordSandboxLogicalProvision,
  recordSandboxProvisionAttempt,
  recordSessionEventAppendLatency,
  recordSessionEventAppendPhase,
  recordSessionEventPublishLatency,
  recordTurnSandboxEstablishPolicy,
  recordTurnStartupMilestone,
  recordTurnStartupPhase,
  recordTurnWorkerPreparationTotal,
  StreamTimingMetrics,
  sessionEventBatchSizeClass,
  turnStartupCountBucket,
} from "../src/observability-metrics";

// Streaming SLIs: pin that each new metric hook fires with the right series, the
// right bounded labels, and the right value — so "streaming is sluggish" resolves
// to a number and the layer (model / write / delivery) is attributable.

function worker() {
  return createObservability(testSettings(), { component: "worker" });
}

describe("logical sandbox provision metrics", () => {
  test("separates internal lifecycle retries from one terminal logical outcome", async () => {
    const observability = worker();
    recordSandboxProvisionAttempt(observability, {
      backend: "modal",
      stage: "lease_admission",
      category: "lease_superseded",
      outcome: "retrying",
      durationSeconds: 0.25,
    });
    recordSandboxProvisionAttempt(observability, {
      backend: "modal",
      stage: "resume",
      category: "resume",
      outcome: "completed",
      durationSeconds: 0.5,
    });
    recordSandboxLogicalProvision(observability, {
      backend: "modal",
      stage: "resume",
      category: "none",
      outcome: "completed",
      expected: false,
      internalAttempts: 2,
      durationSeconds: 1,
    });
    recordSandboxLogicalProvision(observability, {
      backend: "modal",
      stage: "lifecycle_wait",
      category: "drain_capture_wait",
      outcome: "expected_transition",
      expected: true,
      internalAttempts: 3,
      durationSeconds: 2,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_sandbox_provision_attempts_total\{[^}]*category="lease_superseded"[^}]*outcome="retrying"[^}]*stage="lease_admission"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_provisions_total\{[^}]*category="none"[^}]*expected="false"[^}]*outcome="completed"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_provisions_total\{[^}]*category="drain_capture_wait"[^}]*expected="true"[^}]*outcome="expected_transition"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_sandbox_provision_internal_attempts_sum\{[^}]*category="none"[^}]*\} 2\b/,
    );
  });
});

describe("StreamTimingMetrics — TTFT + inter-delta gaps", () => {
  test("first content delta records TTFT from the response (re)start anchor", async () => {
    const observability = worker();
    let now = 1_000;
    const timing = new StreamTimingMetrics(observability, {
      provider: "openai",
      now: () => now,
    });

    now = 2_000; // 1.0s after construction (≈ runStream start)
    timing.onEvent("agent.message.delta");

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_stream_ttft_seconds_sum\{[^}]*provider="openai"[^}]*\} 1\b/);
    expect(metrics).toMatch(
      /opengeni_stream_ttft_seconds_count\{[^}]*provider="openai"[^}]*\} 1\b/,
    );
  });

  test("re-arms TTFT after a non-content event (a post-tool response measures model restart)", async () => {
    const observability = worker();
    let now = 1_000;
    const timing = new StreamTimingMetrics(observability, {
      provider: "openai",
      now: () => now,
    });

    now = 2_000;
    timing.onEvent("agent.message.delta"); // TTFT #1 = 1.0
    now = 3_000;
    timing.onEvent("agent.toolCall.output"); // non-content → re-arm anchor to 3_000
    now = 4_000;
    timing.onEvent("agent.reasoning.delta"); // TTFT #2 = 1.0 (measured from the tool boundary)

    const metrics = await observability.prometheusMetrics();
    // Two observations, summing to 2.0 — the second did NOT include the 1.0s tool gap.
    expect(metrics).toMatch(/opengeni_stream_ttft_seconds_sum\{[^}]*provider="openai"[^}]*\} 2\b/);
    expect(metrics).toMatch(
      /opengeni_stream_ttft_seconds_count\{[^}]*provider="openai"[^}]*\} 2\b/,
    );
  });

  test("inter-delta gaps are measured per class and reset across a boundary", async () => {
    const observability = worker();
    let now = 1_000;
    const timing = new StreamTimingMetrics(observability, {
      provider: "azure",
      now: () => now,
    });

    timing.onEvent("agent.message.delta"); // first — no gap
    now = 1_500;
    timing.onEvent("agent.message.delta"); // gap 0.5
    now = 2_000;
    timing.onEvent("agent.message.delta"); // gap 0.5
    now = 2_500;
    timing.onEvent("agent.toolCall.output"); // boundary → clears the run
    now = 5_000;
    timing.onEvent("agent.message.delta"); // first after boundary — NO gap spanning the tool

    const metrics = await observability.prometheusMetrics();
    // Two gaps of 0.5s each: sum 1.0, count 2 — the 2.5s tool gap is excluded.
    expect(metrics).toMatch(
      /opengeni_stream_inter_delta_gap_seconds_sum\{[^}]*class="message"[^}]*provider="azure"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_stream_inter_delta_gap_seconds_count\{[^}]*class="message"[^}]*provider="azure"[^}]*\} 2\b/,
    );
  });

  test("reasoning and message deltas carry distinct class labels", async () => {
    const observability = worker();
    let now = 0;
    const timing = new StreamTimingMetrics(observability, {
      provider: "openai",
      now: () => now,
    });

    timing.onEvent("agent.reasoning.delta");
    now = 100;
    timing.onEvent("agent.reasoning.delta"); // reasoning gap 0.1

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_stream_inter_delta_gap_seconds_count\{[^}]*class="reasoning"[^}]*\} 1\b/,
    );
  });
});

describe("provider request lifecycle diagnostics", () => {
  test("records bounded phase/outcome labels and monotonic duration", async () => {
    const observability = worker();
    recordModelRequestPhase(observability, {
      provider: "codex-subscription",
      phase: "headers",
      durationSeconds: 0.12,
    });
    recordModelRequestPhase(observability, {
      provider: "codex-subscription",
      phase: "first_byte",
      durationSeconds: 0.34,
    });
    recordModelRequestPhase(observability, {
      provider: "codex-subscription",
      phase: "terminal",
      outcome: "completed",
      durationSeconds: 1.2,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_request_phases_total\{[^}]*outcome=""[^}]*phase="headers"[^}]*provider="codex-subscription"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_model_request_phases_total\{[^}]*outcome="completed"[^}]*phase="terminal"[^}]*provider="codex-subscription"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_model_request_phase_duration_seconds_count\{[^}]*phase="first_byte"[^}]*provider="codex-subscription"[^}]*\} 1\b/,
    );
    expect(metrics).not.toContain("requestId");
  });

  test("tracks active SuperGrok requests and valid-event liveness without identity labels", async () => {
    const observability = worker();
    let now = 1_000;
    const lifecycle = new ModelRequestLifecycleMetrics(observability, {
      now: () => now,
      refreshIntervalMs: 60_000,
    });

    lifecycle.start("private-request-id:1", "supergrok-subscription");
    now = 2_500;
    lifecycle.event("private-request-id:1", 1_500);
    now = 7_500;
    lifecycle.refreshGauges();

    let metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_requests_inflight\{[^}]*provider="supergrok-subscription"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_model_request_oldest_no_event_age_seconds\{[^}]*provider="supergrok-subscription"[^}]*\} 5\b/,
    );
    expect(metrics).toMatch(
      /opengeni_model_request_stream_events_total\{[^}]*provider="supergrok-subscription"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_model_request_stream_event_gap_seconds_sum\{[^}]*provider="supergrok-subscription"[^}]*\} 1\.5\b/,
    );
    expect(metrics).not.toContain("private-request-id");

    lifecycle.finish("private-request-id:1");
    metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_requests_inflight\{[^}]*provider="supergrok-subscription"[^}]*\} 0\b/,
    );
    lifecycle.stop();
  });
});

describe("turn startup phase diagnostics", () => {
  test("records cumulative queue-to-milestone SLOs with bounded labels", async () => {
    const observability = worker();
    recordTurnStartupMilestone(observability, {
      milestone: "queue",
      provider: "codex-subscription",
      backend: "modal",
      outcome: "completed",
      durationSeconds: 1.714,
    });
    recordTurnStartupMilestone(observability, {
      milestone: "first_byte",
      provider: "codex-subscription",
      backend: "modal",
      outcome: "completed",
      durationSeconds: 93.168,
    });
    recordTurnStartupMilestone(observability, {
      milestone: "first_byte",
      provider: "codex-subscription",
      backend: "modal",
      outcome: "failed",
      durationSeconds: 120,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_turn_startup_milestone_duration_seconds_sum\{[^}]*backend="modal"[^}]*milestone="queue"[^}]*outcome="completed"[^}]*provider="codex-subscription"[^}]*\} 1\.714\b/,
    );
    expect(metrics).toMatch(
      /opengeni_turn_startup_milestone_duration_seconds_sum\{[^}]*milestone="first_byte"[^}]*\} 93\.168\b/,
    );
    expect(metrics).toMatch(
      /opengeni_turn_startup_milestone_duration_seconds_count\{[^}]*milestone="first_byte"[^}]*outcome="failed"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_turn_startup_milestone_duration_seconds_bucket\{[^}]*le="7200"[^}]*milestone="queue"[^}]*\}/,
    );
    expect(metrics).not.toContain("sessionId");
    expect(metrics).not.toContain("turnId");
  });

  test("records one bounded phase series without request identity", async () => {
    const observability = worker();
    recordTurnStartupPhase(observability, {
      phase: "file_materialization",
      provider: "codex-subscription",
      backend: "selfhosted",
      outcome: "completed",
      durationSeconds: 0.42,
      count: 5,
      cache: "disabled",
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_turn_startup_phase_duration_seconds_sum\{[^}]*backend="selfhosted"[^}]*cache="disabled"[^}]*count_bucket="2-5"[^}]*outcome="completed"[^}]*phase="file_materialization"[^}]*provider="codex-subscription"[^}]*\} 0\.42\b/,
    );
    expect(metrics).not.toContain("sessionId");
    expect(metrics).not.toContain("turnId");
    expect(metrics).not.toContain("credentialId");
  });

  test("separates lazy request preparation from the durable request-start audit", async () => {
    const observability = worker();
    recordTurnStartupPhase(observability, {
      phase: "model_request_preparation",
      provider: "codex-subscription",
      backend: "docker",
      outcome: "completed",
      durationSeconds: 0.21,
    });
    recordTurnStartupPhase(observability, {
      phase: "model_request_audit",
      provider: "codex-subscription",
      backend: "docker",
      outcome: "completed",
      durationSeconds: 0.08,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_turn_startup_phase_duration_seconds_sum\{[^}]*phase="model_request_preparation"[^}]*\} 0\.21\b/,
    );
    expect(metrics).toMatch(
      /opengeni_turn_startup_phase_duration_seconds_sum\{[^}]*phase="model_request_audit"[^}]*\} 0\.08\b/,
    );
  });

  test("records bounded tool-preparation subphases", async () => {
    const observability = worker();
    for (const phase of [
      "tool_server_construction",
      "tool_required_connect",
      "tool_optional_connect",
      "tool_attempt_catalog_build",
      "tool_attempt_catalog_persist",
    ] as const) {
      recordTurnStartupPhase(observability, {
        phase,
        provider: "codex-subscription",
        backend: "docker",
        outcome: "completed",
        durationSeconds: 0.01,
        count: 1,
      });
    }

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_turn_startup_phase_duration_seconds_count\{[^}]*phase="tool_server_construction"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_turn_startup_phase_duration_seconds_count\{[^}]*phase="tool_attempt_catalog_persist"[^}]*\} 1\b/,
    );
  });

  test("records worker preparation separately from lazy request phases", async () => {
    const observability = worker();
    recordTurnWorkerPreparationTotal(observability, {
      provider: "codex-subscription",
      backend: "docker",
      outcome: "completed",
      durationSeconds: 1.4,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_turn_worker_preparation_duration_seconds_sum\{[^}]*backend="docker"[^}]*outcome="completed"[^}]*provider="codex-subscription"[^}]*\} 1\.4\b/,
    );
  });

  test("records only bounded sandbox establish-policy labels", async () => {
    const observability = worker();
    recordTurnSandboxEstablishPolicy(observability, {
      policy: "on-demand",
      reason: "eligible",
      backend: "docker",
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_turn_sandbox_establish_policy_total\{[^}]*backend="docker"[^}]*policy="on-demand"[^}]*reason="eligible"[^}]*\} 1\b/,
    );
    expect(metrics).not.toContain("sessionId");
    expect(metrics).not.toContain("sandboxId");
    expect(metrics).not.toContain("credentialId");
  });

  test("buckets setup cardinality without exposing raw counts", () => {
    expect([-1, Number.NaN, Number.POSITIVE_INFINITY].map(turnStartupCountBucket)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
    expect([0, 1, 2, 5, 6, 20, 21].map(turnStartupCountBucket)).toEqual([
      "0",
      "1",
      "2-5",
      "2-5",
      "6-20",
      "6-20",
      "21+",
    ]);
  });
});

describe("batcher flush shape", () => {
  test("records flush event count and duration histograms", async () => {
    const observability = worker();
    recordBatchFlush(observability, { events: 50, durationSeconds: 0.01 });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_stream_batch_flush_events_sum\{[^}]*\} 50\b/);
    expect(metrics).toMatch(/opengeni_stream_batch_flush_duration_seconds_count\{[^}]*\} 1\b/);
  });
});

describe("event I/O latency split (write path vs delivery)", () => {
  test("append and publish latency are distinct series", async () => {
    const observability = worker();
    recordSessionEventAppendLatency(observability, { durationSeconds: 0.02 });
    recordSessionEventPublishLatency(observability, { durationSeconds: 0.03 });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(/opengeni_session_event_append_seconds_sum\{[^}]*\} 0\.02\b/);
    expect(metrics).toMatch(/opengeni_session_event_publish_seconds_sum\{[^}]*\} 0\.03\b/);
  });

  test("records bounded append phase attribution without tenant identifiers", async () => {
    const observability = worker();
    recordSessionEventAppendPhase(observability, {
      phase: "turn_attempt_fence",
      eventClass: "mixed",
      eventCount: 12,
      outcome: "rejected",
      durationSeconds: 0.04,
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_session_event_append_phase_seconds_sum\{[^}]*batch_size_class="11-25"[^}]*event_class="mixed"[^}]*outcome="rejected"[^}]*path="turn_attempt"[^}]*phase="turn_attempt_fence"[^}]*\} 0\.04\b/,
    );
    expect(metrics).not.toContain("workspace_id");
    expect(metrics).not.toContain("session_id");
  });

  test("buckets append batch sizes into a closed label set", () => {
    expect([0, 1, 2, 5, 6, 10, 11, 25, 26, 50, 51].map(sessionEventBatchSizeClass)).toEqual([
      "unknown",
      "1",
      "2-5",
      "2-5",
      "6-10",
      "6-10",
      "11-25",
      "11-25",
      "26-50",
      "26-50",
      "51+",
    ]);
  });
});

describe("context-pressure signals", () => {
  test("model input tokens histogram labels by provider and skips non-positive", async () => {
    const observability = worker();
    recordModelInputTokens(observability, "openai", 50_000);
    recordModelInputTokens(observability, "openai", 0); // skipped
    recordModelInputTokens(observability, "openai", -5); // skipped

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_model_input_tokens_sum\{[^}]*provider="openai"[^}]*\} 50000\b/,
    );
    expect(metrics).toMatch(/opengeni_model_input_tokens_count\{[^}]*provider="openai"[^}]*\} 1\b/);
  });

  test("publishes every closed compaction trigger at zero before the first event", async () => {
    const observability = worker();
    initializeContextCompactionMetrics(observability);

    const metrics = await observability.prometheusMetrics();
    for (const trigger of ["auto", "operator", "proactive", "overflow"]) {
      expect(metrics).toMatch(
        new RegExp(
          `opengeni_context_compaction_starts_total\\{[^}]*trigger="${trigger}"[^}]*\\} 0\\b`,
        ),
      );
      expect(metrics).toMatch(
        new RegExp(`opengeni_context_compactions_total\\{[^}]*trigger="${trigger}"[^}]*\\} 0\\b`),
      );
    }
  });

  test("compaction lifecycle metrics update by trigger", async () => {
    const observability = worker();
    initializeContextCompactionMetrics(observability);
    recordContextCompactionStarted(observability, "auto");
    initializeContextCompactionMetrics(observability);
    recordContextCompactionStarted(observability, "operator");
    recordContextCompaction(observability, "overflow");
    recordContextCompaction(observability, "overflow");
    recordContextCompaction(observability, "operator");

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_context_compaction_starts_total\{[^}]*trigger="auto"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_context_compaction_starts_total\{[^}]*trigger="operator"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_context_compactions_total\{[^}]*trigger="overflow"[^}]*\} 2\b/,
    );
    expect(metrics).toMatch(
      /opengeni_context_compactions_total\{[^}]*trigger="operator"[^}]*\} 1\b/,
    );
    expect(metrics).not.toContain("opengeni_context_compaction_last_event_timestamp_seconds");
  });

  test("Company Brain exposure metrics use only bounded classification labels", async () => {
    const observability = worker();
    recordCompanyBrainContributions(observability, {
      attemptId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      sessionRole: "child",
      memoryPromptMode: "retrieval_only",
      instructionPolicySnapshotId: crypto.randomUUID(),
      preferenceSnapshotId: null,
      companyProfileSnapshotId: crypto.randomUUID(),
      contributions: [
        {
          category: "mandatory_rule",
          source: "workspace_instruction_policy",
          inclusionReason: "active_instruction_policy",
          authorityScope: "workspace",
          utf8Bytes: 40,
          estimatedTokens: 10,
        },
      ],
    });

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toContain('category="mandatory_rule"');
    expect(metrics).toContain('session_role="child"');
    expect(metrics).toContain('memory_prompt_mode="retrieval_only"');
    expect(metrics).not.toContain("attemptId");
  });
});
