import { MessageTimeline, OpenGeniProvider, useLastStartedTurnPolicy } from "@opengeni/react";
import type { SessionEvent } from "@opengeni/sdk";
import { fakeClient, fakeTurn, WORKSPACE_ID } from "../../../../../packages/react/test/fake-client";
import { SessionHeader } from "../../../src/components/rail/session-header";
import { ModelAccountIndicator } from "../../../src/components/session/model-account-indicator";
import { isIntelligenceEffort } from "../../../src/lib/session-tools";
import type { Session } from "../../../src/types";

const turn = fakeTurn({ model: "codex/gpt-6-astra", reasoningEffort: "high" });
const session = {
  id: turn.sessionId, workspaceId: WORKSPACE_ID, title: "Quarterly planning notes",
  initialMessage: "Summarize the quarterly plan.", parentSessionId: null,
  model: turn.model, reasoningEffort: "high", latencyMode: "standard", metadata: {},
  status: "running", pinned: false,
  effectiveControl: { state: "active", directState: "active", primaryBlocker: null, additionalBlockerCount: 0 },
} as Session;
const events: SessionEvent[] = [
  { type: "subscription.account.switched", payload: { reason: "failover_cross_provider", fromProvider: "codex", provider: "claude" } },
  { type: "subscription.account.selected", payload: { provider: "claude", modelId: "claude-sub/opus" } },
].map((entry, index) => ({ ...entry, id: `preview-${index}`, workspaceId: WORKSPACE_ID,
  sessionId: session.id, turnId: turn.id, sequence: index + 1, occurredAt: "2026-10-12T12:00:00Z" }));
const client = fakeClient({
  listTurns: async () => [turn],
  getSessionModelAccount: async () => ({
    binding: null,
    bindings: [{ provider: "claude", connectionId: "team-a", choice: "automatic" }],
    serving: { turnId: turn.id, provider: "claude", connectionId: "team-a", modelId: "claude-sub/opus",
      preferredModelId: turn.model, reasoningEffort: "high", latencyMode: "standard" },
    accounts: [{ provider: "claude", connectionId: "team-a", label: "Acme Claude", accountEmail: null,
      planType: "Max", status: "active", personal: false, source: "organization", allowedModelIds: null,
      choosable: true, refusal: null, usage: null }],
    personal: { connectionsAllowed: true, fallbackAllowed: false, fallbackOptIn: false },
  }),
});

function Content() {
  const { policy, loading } = useLastStartedTurnPolicy(session.id, { events, includeServingModel: true });
  return <main className="min-h-screen bg-bg text-fg" data-preferred-model={session.model} data-serving-model={policy?.model}>
    <SessionHeader session={session} ancestors={[]} connectionState="live" status="running"
      keyAuthRequired={false} onForgetAccessKey={() => undefined} inspectorOpen={false}
      onToggleInspector={() => undefined} onRename={async () => null} onPin={async () => null}
      lastStartedModel={policy?.model} policyLoading={loading} modelLabel="Claude Opus 5.5"
      lastStartedReasoningEffort={isIntelligenceEffort(policy?.reasoningEffort) ? policy.reasoningEffort : undefined}
      lastStartedLatencyMode={policy?.latencyMode} billingClass="claude_subscription"
      codexSlot={<ModelAccountIndicator workspaceId={WORKSPACE_ID} sessionId={session.id}
        provider="claude" organizationId="preview-org" servingTurnId={policy?.turnId} events={events} />}
    />
    <div className="mx-auto max-w-3xl px-4 py-8"><MessageTimeline events={events} status="running" /></div>
    <p className="fixed right-3 bottom-3 left-3 text-xs text-fg-subtle">Preview · Synthetic serving receipt · Production header and timeline</p>
  </main>;
}

export function ServingPreview() {
  return <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}><Content /></OpenGeniProvider>;
}
