import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  recordBatchFlush,
  recordContextCompaction,
  recordModelInputTokens,
  recordModelRequestPhase,
  recordSessionEventAppendLatency,
  recordSessionEventPublishLatency,
  AgentLoopPhaseTracker,
  recordAgentLoopPhaseDuration,
  StreamTimingMetrics,
} from "../src/observability-metrics";

// Streaming SLIs: pin that each new metric hook fires with the right series, the
// right bounded labels, and the right value — so "streaming is sluggish" resolves
// to a number and the layer (model / write / delivery) is attributable.

function worker() {
  return createObservability(testSettings(), { component: "worker" });
}

describe("StreamTimingMetrics — TTFT + inter-delta gaps", () => {
  test("first content delta records TTFT from the response (re)start anchor", async () => {
    const observability = worker();
    let now = 1_000;
    const timing = new StreamTimingMetrics(observability, { provider: "openai", now: () => now });

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
    const timing = new StreamTimingMetrics(observability, { provider: "openai", now: () => now });

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
    const timing = new StreamTimingMetrics(observability, { provider: "azure", now: () => now });

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
    const timing = new StreamTimingMetrics(observability, { provider: "openai", now: () => now });

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
});

describe("agent-loop phase timing", () => {
  test("records durable append, live fanout, and cross-boundary phases with closed labels", async () => {
    const observability = worker();
    recordAgentLoopPhaseDuration(observability, {
      phase: "durable_append",
      durationSeconds: 0.02,
    });
    recordAgentLoopPhaseDuration(observability, {
      phase: "live_fanout",
      durationSeconds: 0.03,
    });
    const tracker = new AgentLoopPhaseTracker();
    tracker.markProvisionCompleted();
    tracker.markToolOutput();
    tracker.recordModelRequestStart(observability);

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_agent_loop_phase_duration_seconds_count\{[^}]*phase="durable_append"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_agent_loop_phase_duration_seconds_count\{[^}]*phase="live_fanout"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_agent_loop_phase_duration_seconds_count\{[^}]*phase="provision_to_model_preparation"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_agent_loop_phase_duration_seconds_count\{[^}]*phase="tool_output_to_model_continuation"[^}]*\} 1\b/,
    );
  });

  test("consumes each phase marker once and retains the earliest tool-output boundary", async () => {
    const observability = worker();
    let now = 1_000;
    const tracker = new AgentLoopPhaseTracker(() => now);
    tracker.markProvisionCompleted();
    tracker.markToolOutput();
    now = 2_000;
    tracker.markToolOutput();
    tracker.recordModelRequestStart(observability);
    tracker.recordModelRequestStart(observability);

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_agent_loop_phase_duration_seconds_count\{[^}]*phase="provision_to_model_preparation"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_agent_loop_phase_duration_seconds_count\{[^}]*phase="tool_output_to_model_continuation"[^}]*\} 1\b/,
    );
    expect(metrics).toMatch(
      /opengeni_agent_loop_phase_duration_seconds_sum\{[^}]*phase="tool_output_to_model_continuation"[^}]*\} 1\b/,
    );
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

  test("compaction counter increments by trigger", async () => {
    const observability = worker();
    recordContextCompaction(observability, "overflow");
    recordContextCompaction(observability, "overflow");
    recordContextCompaction(observability, "operator");

    const metrics = await observability.prometheusMetrics();
    expect(metrics).toMatch(
      /opengeni_context_compactions_total\{[^}]*trigger="overflow"[^}]*\} 2\b/,
    );
    expect(metrics).toMatch(
      /opengeni_context_compactions_total\{[^}]*trigger="operator"[^}]*\} 1\b/,
    );
  });
});
