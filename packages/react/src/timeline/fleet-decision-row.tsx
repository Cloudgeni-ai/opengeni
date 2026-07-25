import type { FleetDecisionItem } from "./types";

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
    children: [j("path", { d: "m 12 14 4-4" }), j("path", { d: "M3.34 19a10 10 0 1 1 17.32 0" })],
  });
}

const FLEET_ACTUAL_REASON_LABEL: Record<FleetDecisionItem["actualReason"], string> = {
  lease_reused: "Reused the fenced lease",
  pin: "Kept the session pin",
  rotation: "Rotated for capacity",
  active: "Used the active subscription",
  all_capped: "All observed subscriptions were capped",
  none: "No production candidate was selected",
};

const FLEET_SHADOW_REASON_LABEL: Record<FleetDecisionItem["shadowReason"], string> = {
  fenced_in_flight: "Kept the fenced in-flight assignment",
  fenced_candidate_missing: "The fenced assignment was missing from the snapshot",
  admission_paced: "Admission would have been paced",
  no_eligible_candidate: "No candidate passed the policy checks",
  overlay_isolated_empty: "Explicit isolation left no eligible candidate",
  best_score: "Selected the lowest-pressure candidate",
  affinity_best: "Session affinity was already best",
  hysteresis_hold: "Hysteresis avoided a low-value switch",
};

const FLEET_COMPARISON_LABEL: Record<FleetDecisionItem["comparison"], string> = {
  match: "Production and shadow matched",
  different_candidate: "Shadow preferred another candidate",
  different_outcome: "Production and shadow outcomes differed",
  not_comparable_truncated: "Comparison limited by bounded candidate data",
};

const FLEET_ADMISSION_REASON_LABEL: Record<FleetDecisionItem["admissionReason"], string> = {
  fenced_in_flight: "In-flight assignment was fenced",
  pacing_disabled: "Admission pacing was disabled",
  capacity_unknown: "Capacity was unknown, so work remained admissible",
  capacity_available: "Observed capacity was available",
  work_conserving_borrow: "Idle capacity was borrowed for standard work",
  manager_priority: "Standard work was paced for queued manager demand",
  standard_starvation_bound: "The standard-work starvation bound was reached",
  capacity_saturated: "Observed dynamic capacity was saturated",
  emergency_fuse: "The emergency fuse blocked new work",
};

const FLEET_REJECTION_LABEL: Record<
  Exclude<FleetDecisionItem["scores"][number]["rejectionReason"], null>,
  string
> = {
  allocator_disabled: "Allocator disabled",
  unavailable: "Unavailable",
  cooling: "Cooling down",
  quota_ceiling: "Quota ceiling reached",
  overlay_isolation: "Outside explicit isolation",
};

const FLEET_CONFIDENCE_LABEL: Record<FleetDecisionItem["confidence"], string> = {
  unknown: "Unknown confidence",
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};

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
  const scoreRowsHidden = item.scoreRowsTruncatedCount > 0;
  const scores =
    item.scores.length > 0
      ? j("div", {
          className: "min-w-0",
          children: [
            j("h4", {
              className: "text-og-sm font-medium text-og-fg",
              children: "Bounded candidate scores",
            }),
            j("p", {
              className: "mt-0.5 text-og-xs leading-5 text-og-fg-subtle",
              children:
                "Lower scores rank first. Candidate aliases are temporary and local to this event.",
            }),
            j("ul", {
              className: "mt-2 flex min-w-0 flex-col gap-1.5",
              "aria-label": "Candidate scores",
              children: item.scores.map((score) =>
                s(
                  "li",
                  {
                    className:
                      "flex min-w-0 flex-col gap-1 rounded-og-sm bg-og-surface-1 px-2.5 py-2 text-og-sm sm:flex-row sm:items-center sm:gap-3",
                    children: [
                      j("span", {
                        className: "font-og-mono text-og-fg",
                        children: score.candidateKey,
                      }),
                      j("span", {
                        className: "min-w-0 text-og-fg-muted sm:flex-1",
                        children: score.eligible
                          ? "Eligible"
                          : score.rejectionReason
                            ? FLEET_REJECTION_LABEL[score.rejectionReason]
                            : "Unavailable",
                      }),
                      s("span", {
                        className: "font-og-mono text-og-fg-subtle",
                        children: [
                          "score ",
                          formatFleetScore(score.total),
                          " ·",
                          " ",
                          FLEET_CONFIDENCE_LABEL[score.confidence],
                        ],
                      }),
                    ],
                  },
                  score.candidateKey,
                ),
              ),
            }),
          ],
        })
      : null;
  const truncated =
    item.truncatedCandidateCount > 0
      ? j(BodyNote, {
          tone: "muted",
          children: [
            item.truncatedCandidateCount,
            " additional ",
            item.truncatedCandidateCount === 1 ? "candidate was" : "candidates were",
            " excluded from this bounded replay record.",
          ],
        })
      : null;
  const hidden = scoreRowsHidden
    ? j(BodyNote, {
        tone: "muted",
        children: [
          item.scoreRowsTruncatedCount,
          " additional ",
          item.scoreRowsTruncatedCount === 1 ? "score row was" : "score rows were",
          " hidden by this view’s safety limit.",
        ],
      })
    : null;
  return j(ActivityDisclosure, {
    icon: j(GaugeMark, { className: "size-3.5", j, s }),
    iconTone: "muted",
    title: "Fleet policy shadow",
    preview: FLEET_COMPARISON_LABEL[item.comparison],
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
      "aria-label": "Fleet policy shadow details",
      className: "flex min-w-0 flex-col gap-3",
      children: [
        j(BodyNote, {
          tone: "muted",
          children:
            "Shadow observation only — it did not change the subscription serving this turn.",
        }),
        j("dl", {
          className: "grid min-w-0 grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2",
          children: [
            j(FleetDetail, {
              term: "Production",
              value: fleetOutcomeLabel(item.actualOutcome, item.actualCandidateKey),
              note: FLEET_ACTUAL_REASON_LABEL[item.actualReason],
              j,
              s,
            }),
            j(FleetDetail, {
              term: "Shadow policy",
              value: fleetOutcomeLabel(item.shadowOutcome, item.shadowCandidateKey),
              note: FLEET_SHADOW_REASON_LABEL[item.shadowReason],
              j,
              s,
            }),
            j(FleetDetail, {
              term: "Comparison",
              value: FLEET_COMPARISON_LABEL[item.comparison],
              j,
              s,
            }),
            j(FleetDetail, {
              term: "Decision confidence",
              value: FLEET_CONFIDENCE_LABEL[item.confidence],
              j,
              s,
            }),
            j(FleetDetail, {
              term: "Admission",
              value:
                item.admissionOutcome === "admit" ? "Would admit new work" : "Would pace new work",
              note: FLEET_ADMISSION_REASON_LABEL[item.admissionReason],
              j,
              s,
            }),
            j(FleetDetail, {
              term: "Observed candidates",
              value: `${item.candidateCount} in the bounded replay`,
              j,
              s,
            }),
            j(FleetDetail, {
              term: "Idle-capacity borrowing",
              value: item.borrowedIdleCapacity ? "Borrowed for standard work" : "Not borrowed",
              j,
              s,
            }),
            j(FleetDetail, {
              term: "Named-policy borrowing",
              value: item.borrowedOverlayCapacity
                ? "Borrowed outside the preferred group"
                : "Not borrowed",
              j,
              s,
            }),
            j(FleetDetail, {
              term: "Stranded capacity",
              value:
                item.strandedEligibleCount === 0
                  ? "None"
                  : `${item.strandedEligibleCount} eligible ${item.strandedEligibleCount === 1 ? "candidate" : "candidates"}`,
              note:
                item.strandedEligibleCount > 0
                  ? "Capacity excluded by explicit isolation; existing fenced turns are unchanged."
                  : undefined,
              j,
              s,
            }),
          ],
        }),
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
      j("dt", {
        className: "text-og-xs font-medium uppercase tracking-wide text-og-fg-subtle",
        children: term,
      }),
      s("dd", {
        className: "mt-0.5 break-words text-og-sm text-og-fg-muted",
        children: [
          j("span", { className: "text-og-fg", children: value }),
          note ? j("span", { className: "mt-0.5 block leading-5", children: note }) : null,
        ],
      }),
    ],
  });
}

function fleetOutcomeLabel(
  outcome: FleetDecisionItem["actualOutcome"] | FleetDecisionItem["shadowOutcome"],
  candidateKey: string | null,
): string {
  if (outcome === "selected" && candidateKey) return `Selected ${candidateKey}`;
  if (outcome === "waiting") return "Waiting for capacity";
  if (outcome === "paced") return "Paced before placement";
  return "No candidate selected";
}

function formatFleetScore(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}
