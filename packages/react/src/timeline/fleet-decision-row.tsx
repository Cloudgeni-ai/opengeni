import type { FleetDecisionItem } from "./types";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";

type RowJsx = typeof import("react/jsx-runtime").jsx;
type RowJsxs = typeof import("react/jsx-runtime").jsxs;

function GaugeMark({ className, j, s }: { className: string; j: RowJsx; s: RowJsxs }) {
  return s("svg", {
    "aria-hidden": "true",
    className,
    fill: "none",
    height: "24",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: "2",
    viewBox: "0 0 24 24",
    width: "24",
    children: [
      j("path", { d: "m 12 14 4-4" }, "needle"),
      j("path", { d: "M3.34 19a10 10 0 1 1 17.32 0" }, "arc"),
    ],
  });
}

const FLEET_ACTUAL_REASON_LABEL = (
  t: OpenGeniText,
): Record<FleetDecisionItem["actualReason"], string> => ({
  lease_reused: t("timeline.fleetDecisionRow.reusedTheFencedLease"),
  pin: t("timeline.fleetDecisionRow.keptTheSessionPin"),
  rotation: t("timeline.fleetDecisionRow.rotatedForCapacity"),
  active: t("timeline.fleetDecisionRow.usedTheActiveSubscription"),
  all_capped: t("timeline.fleetDecisionRow.allObservedSubscriptionsWereCapped"),
  allocator_disabled: t("timeline.fleetDecisionRow.thePolicySelectedSubscriptionWas"),
  none: t("timeline.fleetDecisionRow.noProductionCandidateWasSelected"),
});

const FLEET_SHADOW_REASON_LABEL = (
  t: OpenGeniText,
): Record<FleetDecisionItem["shadowReason"], string> => ({
  fenced_in_flight: t("timeline.fleetDecisionRow.keptTheFencedInFlight"),
  fenced_candidate_missing: t("timeline.fleetDecisionRow.theFencedAssignmentWasMissing"),
  admission_paced: t("timeline.fleetDecisionRow.admissionWouldHaveBeenPaced"),
  no_eligible_candidate: t("timeline.fleetDecisionRow.noCandidatePassedThePolicy"),
  overlay_isolated_empty: t("timeline.fleetDecisionRow.explicitIsolationLeftNoEligible"),
  best_score: t("timeline.fleetDecisionRow.selectedTheLowestPressureCandidate"),
  affinity_best: t("timeline.fleetDecisionRow.sessionAffinityWasAlreadyBest"),
  hysteresis_hold: t("timeline.fleetDecisionRow.hysteresisAvoidedALowValue"),
});

const FLEET_COMPARISON_LABEL = (
  t: OpenGeniText,
): Record<FleetDecisionItem["comparison"], string> => ({
  match: t("timeline.fleetDecisionRow.productionAndShadowMatched"),
  different_candidate: t("timeline.fleetDecisionRow.shadowPreferredAnotherCandidate"),
  different_outcome: t("timeline.fleetDecisionRow.productionAndShadowOutcomesDiffered"),
  not_comparable_truncated: t("timeline.fleetDecisionRow.comparisonLimitedByBoundedCandidate"),
});

const FLEET_ADMISSION_REASON_LABEL = (
  t: OpenGeniText,
): Record<FleetDecisionItem["admissionReason"], string> => ({
  fenced_in_flight: t("timeline.fleetDecisionRow.inFlightAssignmentWasFenced"),
  pacing_disabled: t("timeline.fleetDecisionRow.admissionPacingWasDisabled"),
  capacity_unknown: t("timeline.fleetDecisionRow.capacityWasUnknownSoWork"),
  capacity_available: t("timeline.fleetDecisionRow.observedCapacityWasAvailable"),
  work_conserving_borrow: t("timeline.fleetDecisionRow.idleCapacityWasBorrowedFor"),
  manager_priority: t("timeline.fleetDecisionRow.standardWorkWasPacedFor"),
  standard_starvation_bound: t("timeline.fleetDecisionRow.theStandardWorkStarvationBound"),
  capacity_saturated: t("timeline.fleetDecisionRow.observedDynamicCapacityWasSaturated"),
  emergency_fuse: t("timeline.fleetDecisionRow.theEmergencyFuseBlockedNew"),
});

const FLEET_REJECTION_LABEL = (
  t: OpenGeniText,
): Record<Exclude<FleetDecisionItem["scores"][number]["rejectionReason"], null>, string> => ({
  allocator_disabled: t("timeline.fleetDecisionRow.allocatorDisabled"),
  unavailable: t("timeline.fleetDecisionRow.unavailable"),
  cooling: t("timeline.fleetDecisionRow.coolingDown"),
  quota_ceiling: t("timeline.fleetDecisionRow.quotaCeilingReached"),
  overlay_isolation: t("timeline.fleetDecisionRow.outsideExplicitIsolation"),
});

const FLEET_CONFIDENCE_LABEL = (
  t: OpenGeniText,
): Record<FleetDecisionItem["confidence"], string> => ({
  unknown: t("timeline.fleetDecisionRow.unknownConfidence"),
  low: t("timeline.fleetDecisionRow.lowConfidence"),
  medium: t("timeline.fleetDecisionRow.mediumConfidence"),
  high: t("timeline.fleetDecisionRow.highConfidence"),
});

export default function FleetDecisionRow({
  item,
  d: ActivityDisclosure,
  b: BodyNote,
  j,
  s,
}: {
  item: FleetDecisionItem;
  d: typeof import("./shared").ActivityDisclosure;
  b: typeof import("./shared").BodyNote;
  j: RowJsx;
  s: RowJsxs;
}) {
  const t = useOpenGeniText();
  const scoreRowsHidden = item.scoreRowsTruncatedCount > 0;
  const scores =
    item.scores.length > 0
      ? j(
          "div",
          {
            className: "min-w-0",
            children: [
              j(
                "h4",
                {
                  className: "text-og-sm font-medium text-og-fg",
                  children: t("timeline.fleetDecisionRow.boundedCandidateScores"),
                },
                "heading",
              ),
              j(
                "p",
                {
                  className: "mt-0.5 text-og-xs leading-5 text-og-fg-subtle",
                  children: t("timeline.fleetDecisionRow.lowerScoresRankFirstCandidate"),
                },
                "description",
              ),
              j(
                "ul",
                {
                  className: "mt-2 flex min-w-0 flex-col gap-1.5",
                  "aria-label": t("timeline.fleetDecisionRow.candidateScores"),
                  children: item.scores.map((score) =>
                    s(
                      "li",
                      {
                        className:
                          "flex min-w-0 flex-col gap-1 rounded-og-sm bg-og-surface-1 px-2.5 py-2 text-og-sm sm:flex-row sm:items-center sm:gap-3",
                        children: [
                          j(
                            "span",
                            {
                              className: "font-og-mono text-og-fg",
                              children: score.candidateKey,
                            },
                            "candidate",
                          ),
                          j(
                            "span",
                            {
                              className: "min-w-0 text-og-fg-muted sm:flex-1",
                              children: score.eligible
                                ? t("timeline.fleetDecisionRow.eligible")
                                : score.rejectionReason
                                  ? FLEET_REJECTION_LABEL(t)[score.rejectionReason]
                                  : t("timeline.fleetDecisionRow.unavailable"),
                            },
                            "eligibility",
                          ),
                          s(
                            "span",
                            {
                              className: "font-og-mono text-og-fg-subtle",
                              children: [
                                "score ",
                                formatFleetScore(t, score.total),
                                " ·",
                                " ",
                                FLEET_CONFIDENCE_LABEL(t)[score.confidence],
                              ],
                            },
                            "score",
                          ),
                        ],
                      },
                      score.candidateKey,
                    ),
                  ),
                },
                "rows",
              ),
            ],
          },
          "score-list",
        )
      : null;
  const truncated =
    item.truncatedCandidateCount > 0
      ? j(
          BodyNote,
          {
            tone: "muted",
            children: [
              item.truncatedCandidateCount,
              " additional ",
              item.truncatedCandidateCount === 1
                ? t("timeline.fleetDecisionRow.candidateWas")
                : t("timeline.fleetDecisionRow.candidatesWere"),
              ` ${t("timeline.fleetDecisionRow.excludedFromThisBoundedReplay")}`,
            ],
          },
          "truncated",
        )
      : null;
  const hidden = scoreRowsHidden
    ? j(
        BodyNote,
        {
          tone: "muted",
          children: [
            item.scoreRowsTruncatedCount,
            " additional ",
            item.scoreRowsTruncatedCount === 1
              ? t("timeline.fleetDecisionRow.scoreRowWas")
              : t("timeline.fleetDecisionRow.scoreRowsWere"),
            ` ${t("timeline.fleetDecisionRow.hiddenByThisViewS")}`,
          ],
        },
        "hidden",
      )
    : null;
  return j(ActivityDisclosure, {
    icon: j(GaugeMark, { className: "size-3.5", j, s }),
    iconTone: "muted",
    title: t("timeline.fleetDecisionRow.fleetPolicyShadow"),
    preview: FLEET_COMPARISON_LABEL(t)[item.comparison],
    chip: {
      tone: "muted",
      text:
        item.comparison === "match"
          ? "matched"
          : item.comparison === "not_comparable_truncated"
            ? "limited"
            : "different",
    },
    children: s("section", {
      "aria-label": t("timeline.fleetDecisionRow.fleetPolicyShadowDetails"),
      className: "flex min-w-0 flex-col gap-3",
      children: [
        j(
          BodyNote,
          {
            tone: "muted",
            children: t("timeline.fleetDecisionRow.shadowObservationOnlyItDid"),
          },
          "observation",
        ),
        j(
          "dl",
          {
            className: "grid min-w-0 grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2",
            children: [
              j(
                FleetDetail,
                {
                  term: t("timeline.fleetDecisionRow.production"),
                  value: fleetOutcomeLabel(t, item.actualOutcome, item.actualCandidateKey),
                  note: FLEET_ACTUAL_REASON_LABEL(t)[item.actualReason],
                  j,
                  s,
                },
                "production",
              ),
              j(
                FleetDetail,
                {
                  term: t("timeline.fleetDecisionRow.shadowPolicy"),
                  value: fleetOutcomeLabel(t, item.shadowOutcome, item.shadowCandidateKey),
                  note: FLEET_SHADOW_REASON_LABEL(t)[item.shadowReason],
                  j,
                  s,
                },
                "shadow",
              ),
              j(
                FleetDetail,
                {
                  term: t("timeline.fleetDecisionRow.comparison"),
                  value: FLEET_COMPARISON_LABEL(t)[item.comparison],
                  j,
                  s,
                },
                "comparison",
              ),
              j(
                FleetDetail,
                {
                  term: t("timeline.fleetDecisionRow.decisionConfidence"),
                  value: FLEET_CONFIDENCE_LABEL(t)[item.confidence],
                  j,
                  s,
                },
                "confidence",
              ),
              j(
                FleetDetail,
                {
                  term: t("timeline.fleetDecisionRow.admission"),
                  value:
                    item.admissionOutcome === "admit"
                      ? t("timeline.fleetDecisionRow.wouldAdmitNewWork")
                      : t("timeline.fleetDecisionRow.wouldPaceNewWork"),
                  note: FLEET_ADMISSION_REASON_LABEL(t)[item.admissionReason],
                  j,
                  s,
                },
                "admission",
              ),
              j(
                FleetDetail,
                {
                  term: t("timeline.fleetDecisionRow.observedCandidates"),
                  value: t("timeline.fleetDecisionRow.candidatecountInTheBoundedReplay", {
                    candidateCount: item.candidateCount,
                  }),
                  j,
                  s,
                },
                "candidate-count",
              ),
              j(
                FleetDetail,
                {
                  term: t("timeline.fleetDecisionRow.idleCapacityBorrowing"),
                  value: item.borrowedIdleCapacity
                    ? t("timeline.fleetDecisionRow.borrowedForStandardWork")
                    : t("timeline.fleetDecisionRow.notBorrowed"),
                  j,
                  s,
                },
                "idle-capacity",
              ),
              j(
                FleetDetail,
                {
                  term: t("timeline.fleetDecisionRow.namedPolicyBorrowing"),
                  value: item.borrowedOverlayCapacity
                    ? t("timeline.fleetDecisionRow.borrowedOutsideThePreferredGroup")
                    : t("timeline.fleetDecisionRow.notBorrowed"),
                  j,
                  s,
                },
                "named-policy",
              ),
              j(
                FleetDetail,
                {
                  term: t("timeline.fleetDecisionRow.strandedCapacity"),
                  value:
                    item.strandedEligibleCount === 0
                      ? t("timeline.fleetDecisionRow.none")
                      : t("counts.eligibleCandidates", { count: item.strandedEligibleCount }),
                  note:
                    item.strandedEligibleCount > 0
                      ? t("timeline.fleetDecisionRow.capacityExcludedByExplicitIsolation")
                      : undefined,
                  j,
                  s,
                },
                "stranded-capacity",
              ),
            ],
          },
          "details",
        ),
        scores,
        truncated,
        hidden,
      ],
    }),
  });
}

function FleetDetail({
  term,
  value,
  note,
  j,
  s,
}: {
  term: string;
  value: string;
  note?: string | undefined;
  j: RowJsx;
  s: RowJsxs;
}) {
  return j("div", {
    className: "min-w-0",
    children: [
      j(
        "dt",
        {
          className: "text-og-xs font-medium uppercase tracking-wide text-og-fg-subtle",
          children: term,
        },
        "term",
      ),
      s(
        "dd",
        {
          className: "mt-0.5 break-words text-og-sm text-og-fg-muted",
          children: [
            j("span", { className: "text-og-fg", children: value }, "value"),
            note
              ? j("span", { className: "mt-0.5 block leading-5", children: note }, "note")
              : null,
          ],
        },
        "description",
      ),
    ],
  });
}

function fleetOutcomeLabel(
  t: OpenGeniText,
  outcome: FleetDecisionItem["actualOutcome"] | FleetDecisionItem["shadowOutcome"],
  candidateKey: string | null,
): string {
  if (outcome === "selected" && candidateKey)
    return t("timeline.fleetDecisionRow.selectedCandidatekey", { candidateKey });
  if (outcome === "waiting") return t("timeline.fleetDecisionRow.waitingForCapacity");
  if (outcome === "paced") return t("timeline.fleetDecisionRow.pacedBeforePlacement");
  return t("timeline.fleetDecisionRow.noCandidateSelected");
}

function formatFleetScore(t: OpenGeniText, value: number): string {
  return new Intl.NumberFormat(t.locale, { maximumFractionDigits: 2 }).format(value);
}
