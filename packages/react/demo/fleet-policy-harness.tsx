import type { SessionEvent } from "@opengeni/sdk";
import { createRoot } from "react-dom/client";
import { MessageTimeline } from "../src/index";
import { createFleetPolicyCanonicalProof } from "./fleet-policy-canonical-proof";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";

declare global {
  interface Window {
    __OPE32_CANONICAL_PROOF__?: ReturnType<typeof createFleetPolicyCanonicalProof>;
  }
}

window.__OPE32_CANONICAL_PROOF__ = createFleetPolicyCanonicalProof();
document.documentElement.dataset.ope32CanonicalProofReady = "true";

const events: SessionEvent[] = [
  {
    id: "fleet-demo-event",
    workspaceId: "fleet-demo-workspace",
    sessionId: "fleet-demo-session",
    sequence: 1,
    type: "codex.fleet.decision",
    occurredAt: "2026-07-10T12:00:00.000Z",
    turnId: "fleet-demo-turn",
    turnGeneration: 3,
    turnAttemptId: "fleet-demo-attempt",
    turnAssociation: "current",
    payload: {
      schemaVersion: 1,
      mode: "shadow",
      actual: { outcome: "selected", candidateKey: "c00", reason: "active" },
      comparison: "different_candidate",
      replay: {
        schemaVersion: 1,
        policyVersion: "adaptive-shadow-v1",
        mode: "shadow",
        input: {
          candidates: [{ key: "c00" }, { key: "c01" }, { key: "c02" }],
        },
        truncatedCandidateCount: 2,
        inputFingerprint: "synthetic-fixture-input",
        decisionFingerprint: "synthetic-fixture-decision",
        decision: {
          outcome: "selected",
          selectedCandidateKey: "c01",
          reason: "best_score",
          admission: {
            outcome: "admit",
            reason: "work_conserving_borrow",
            borrowedIdleCapacity: true,
          },
          borrowedOverlayCapacity: false,
          strandedEligibleCount: 1,
          confidence: "low",
          scores: [
            {
              candidateKey: "c00",
              eligible: true,
              rejectionReason: null,
              quotaPressure: 1_300,
              leasePressure: 400,
              inferredBurnPressure: 250,
              runwayPressure: 500,
              uncertaintyPressure: 300,
              cacheAffinityBenefit: -900,
              total: 1_850,
              confidence: "low",
            },
            {
              candidateKey: "c01",
              eligible: true,
              rejectionReason: null,
              quotaPressure: 450,
              leasePressure: 120,
              inferredBurnPressure: 80,
              runwayPressure: 140,
              uncertaintyPressure: 200,
              cacheAffinityBenefit: -150,
              total: 840,
              confidence: "low",
            },
            {
              candidateKey: "c02",
              eligible: false,
              rejectionReason: "overlay_isolation",
              quotaPressure: 200,
              leasePressure: 0,
              inferredBurnPressure: 0,
              runwayPressure: 100,
              uncertaintyPressure: 100,
              cacheAffinityBenefit: 0,
              total: 400,
              confidence: "low",
            },
          ],
        },
      },
    },
  },
];

function FleetPolicyHarness() {
  return (
    <div
      className="og-root min-h-full bg-og-bg"
      data-og-theme={theme === "light" ? "light" : undefined}
    >
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 sm:py-12">
        <header className="mb-8">
          <p className="text-og-xs font-medium uppercase tracking-[0.1em] text-og-fg-subtle">
            OPE-32 acceptance fixture
          </p>
          <h1 className="mt-2 text-xl font-semibold text-og-fg sm:text-2xl">
            Adaptive Codex fleet observability
          </h1>
          <p className="mt-2 max-w-2xl text-og-sm leading-6 text-og-fg-muted">
            A synthetic, identity-free durable event rendered through the production timeline.
            Shadow decisions explain ranking and admission without changing the subscription serving
            an in-flight turn.
          </p>
        </header>

        <section aria-labelledby="decision-heading" className="border-t border-og-border/60 pt-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 id="decision-heading" className="text-og-sm font-medium text-og-fg">
              Latest bounded decision
            </h2>
            <span className="font-og-mono text-og-xs text-og-fg-subtle">
              synthetic · shadow only
            </span>
          </div>
          <MessageTimeline events={events} className="max-h-none" />
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<FleetPolicyHarness />);
