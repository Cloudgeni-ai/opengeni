import { expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { SessionConversation } from "../src/components/session-conversation";
import { ProviderRecoveryNotice } from "../src/components/provider-recovery-notice";
import { presentFailure } from "../src/lib/format";
import {
  currentProviderRecovery,
  parseProviderRecovery,
  providerRecoveryExhaustedText,
  providerRecoveryRetryingText,
} from "../src/lib/provider-recovery";
import { buildTimeline } from "../src/timeline";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const TURN_ID = "44444444-4444-4444-8444-444444444444";

/** Exact worker recovery payload shape for an overloaded Bedrock-served Claude. */
function recoveryPayload(attempt: number): Record<string, unknown> {
  return {
    error: "Claude request failed (HTTP 503)",
    code: "provider_unavailable",
    retryable: true,
    providerCondition: "overloaded",
    model: "claude-opus-5-5",
    modelLabel: "Claude Opus 5.5",
    providerLabel: "Amazon Bedrock",
    continueDelayMs: 15_000,
    providerRecoveryCount: attempt,
    maxProviderRecoveryCount: 5,
    triggerEventId: "55555555-5555-4555-8555-555555555555",
    reason: "provider_unavailable",
  };
}

const exhaustedPayload = {
  error:
    "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock). Opengeni retried 5 times without success. Try again in a few minutes, or switch to another model.",
  code: "provider_unavailable",
  retryable: false,
  providerCondition: "overloaded",
  model: "claude-opus-5-5",
  modelLabel: "Claude Opus 5.5",
  providerLabel: "Amazon Bedrock",
  recoveryExhausted: true,
  providerRecoveryCount: 5,
  maxProviderRecoveryCount: 5,
  lastRetryableError: "Claude request failed (HTTP 503)",
  detail: "overloaded_error: Overloaded",
};

let sequence = 0;
function event(type: string, payload: unknown, turnId: string | null = TURN_ID): SessionEvent {
  sequence += 1;
  return {
    id: `66666666-6666-4666-8666-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date(1_790_000_000_000 + sequence * 1_000).toISOString(),
    turnId,
  } as SessionEvent;
}

test("live retry status names the model, provider condition and attempt", () => {
  const facts = parseProviderRecovery(recoveryPayload(2));
  expect(facts).toEqual({
    code: "provider_unavailable",
    condition: "overloaded",
    modelLabel: "Claude Opus 5.5",
    providerLabel: "Amazon Bedrock",
    attempt: 2,
    maxAttempts: 5,
    modelRoute: true,
  });
  expect(providerRecoveryRetryingText(facts!)).toBe(
    "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock) — retrying (attempt 2 of 5)…",
  );
});

test("a turn parked behind a sandbox rotation says why it is waiting", () => {
  const facts = parseProviderRecovery({
    reason: "sandbox_deadline_rotation",
    sandboxGroupId: "group",
    leaseEpoch: 5,
    rotationReason: "provider_deadline",
    transitionReason: "rotation_in_progress",
  });
  expect(facts).toMatchObject({ sandboxWait: true, modelRoute: false });
  expect(providerRecoveryRetryingText(facts!)).toBe(
    "The sandbox reached its maximum lifetime, so Opengeni is moving the workspace to a fresh sandbox…",
  );
  const lifecycle = (detail: Record<string, unknown>) =>
    providerRecoveryRetryingText(
      parseProviderRecovery({ reason: "sandbox_lifecycle_transition", ...detail })!,
    );
  expect(lifecycle({ transitionReason: "capture_in_progress" })).toBe(
    "Opengeni is saving the sandbox workspace…",
  );
  expect(lifecycle({ transitionReason: "provider_recovery_in_progress" })).toBe(
    "Opengeni is recovering the sandbox…",
  );
  expect(lifecycle({ rotationReason: "operator" })).toBe(
    "Opengeni is moving the workspace to a fresh sandbox…",
  );
  expect(
    providerRecoveryRetryingText(
      parseProviderRecovery({ reason: "sandbox_lease_superseded", rotationReason: "operator" })!,
    ),
  ).toBe("Opengeni is moving the workspace to a fresh sandbox…");
  // A superseded lease with no recorded pending transition is not a wait.
  expect(parseProviderRecovery({ reason: "sandbox_lease_superseded" })).toBeNull();
});

test("the sandbox wait notice promises no retry budget", async () => {
  const facts = parseProviderRecovery({ reason: "sandbox_deadline_rotation" });
  const view = await renderComponent(<ProviderRecoveryNotice recovery={facts} />);
  try {
    const text = view.container.textContent ?? "";
    expect(text).toContain("moving the workspace to a fresh sandbox");
    expect(text).toContain("continues automatically as soon as the sandbox is ready");
    expect(text).not.toContain("retrying");
  } finally {
    await view.unmount();
  }
});

test("other recovery reasons are never presented as provider outages", () => {
  for (const payload of [
    { reason: "human_retry", failureEventId: "x" },
    { reason: "graceful_worker_shutdown" },
    { reason: "sandbox_setup_physically_settled", retryable: true },
    { code: "codex_capacity_recovery_exhausted", recoveryExhausted: true, retryable: false },
    { code: "provider_unavailable", retryable: false },
    null,
    "provider_unavailable",
  ]) {
    expect(parseProviderRecovery(payload)).toBeNull();
  }
});

test("only the active turn's newest boundary drives the live status", () => {
  const session = {
    id: SESSION_ID,
    status: "recovering" as const,
    activeTurnId: TURN_ID,
    effectiveControl: { state: "active" },
  };
  const first = event("turn.recovery.requested", recoveryPayload(1));
  const restarted = event("turn.started", {});
  const second = event("turn.recovery.requested", recoveryPayload(2));
  expect(currentProviderRecovery(session, [second, restarted, first])?.attempt).toBe(2);
  expect(currentProviderRecovery(session, [first, restarted])).toBeNull();
  expect(currentProviderRecovery({ ...session, status: "running" }, [first])).toBeNull();
  expect(
    currentProviderRecovery({ ...session, effectiveControl: { state: "paused" } }, [first]),
  ).toBeNull();
});

test("an exhausted failure reads as one plain sentence in the timeline, not raw provider text", () => {
  expect(presentFailure(exhaustedPayload).reason).toBe(exhaustedPayload.error);
  const items = buildTimeline([
    event("turn.recovery.requested", recoveryPayload(5)),
    event("turn.failed", exhaustedPayload),
  ]);
  const notice = items.find((item) => item.kind === "notice");
  expect(notice).toMatchObject({ tone: "failed", text: exhaustedPayload.error });
  expect(items.find((item) => item.kind === "turn-end")).toMatchObject({
    outcome: "failed",
    failureText: exhaustedPayload.error,
  });
  // Recovery requests themselves never add timeline rows.
  expect(items.filter((item) => item.kind === "notice")).toHaveLength(1);
});

test("legacy exhausted payloads lose the internal wrapper wording", () => {
  const legacy = {
    error:
      "Automatic same-turn recovery stopped after 5 retries because the upstream dependency remained unavailable. Send a new message to retry after the dependency recovers.",
    code: "provider_unavailable",
    retryable: false,
    recoveryExhausted: true,
    providerRecoveryCount: 5,
    maxProviderRecoveryCount: 5,
    lastRetryableError: "503 Service Unavailable: model overloaded",
  };
  expect(presentFailure(legacy).reason).toBe(
    "The model is overloaded at the provider. Opengeni retried 5 times without success. Try again in a few minutes, or switch to another model.",
  );
  expect(
    providerRecoveryExhaustedText(
      parseProviderRecovery({ ...legacy, code: "mcp_transport_timeout", lastRetryableError: "x" })!,
    ),
  ).toBe(
    "A required MCP server isn't responding. Opengeni retried 5 times without success. Try again in a few minutes.",
  );
});

test("the notice renders one live status and nothing without a recovery", async () => {
  const facts = parseProviderRecovery(recoveryPayload(3));
  const view = await renderComponent(<ProviderRecoveryNotice recovery={facts} />);
  try {
    const status = view.container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain(
      "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock) — retrying (attempt 3 of 5)…",
    );
    expect(view.container.querySelector("button")).toBeNull();
  } finally {
    await view.unmount();
  }
  const empty = await renderComponent(<ProviderRecoveryNotice recovery={null} />);
  try {
    expect(empty.container.textContent).toBe("");
  } finally {
    await empty.unmount();
  }
});

test("an embedded conversation shows the live retry status above the composer", async () => {
  const events = [
    event("user.message", { text: "Summarize the launch" }),
    event("turn.started", {}),
    event("turn.recovery.requested", recoveryPayload(2)),
    event("session.status.changed", { status: "recovering" }),
  ];
  const client = fakeClient({
    getSession: async () =>
      ({
        id: SESSION_ID,
        status: "recovering",
        activeTurnId: TURN_ID,
        effectiveControl: { state: "active" },
      }) as never,
    getQueue: async () => ({ items: [], pendingInputs: [] }) as never,
    listHumanInputRequests: async () => [],
    streamEvents: async function* () {},
    listEvents: async () => events as never,
  });
  const view = await renderComponent(
    <SessionConversation
      client={client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />,
  );
  try {
    await flush(100);
    const notice = view.container.querySelector("[data-og-provider-recovery]");
    expect(notice?.textContent).toContain(
      "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock) — retrying (attempt 2 of 5)…",
    );
    expect(notice?.closest("[data-og-conversation-inputs]")).not.toBeNull();
  } finally {
    await view.unmount();
  }
});
