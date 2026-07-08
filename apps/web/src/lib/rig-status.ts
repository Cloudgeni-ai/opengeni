// Human-facing vocabulary for rigs. The domain uses enum slugs
// (`setup_append`, `definition_edit`, `proposed`, `verifying`, ...); this is the
// single boundary that translates them into sentence-case labels and maps them
// onto the shared StatusDot tone language. No rig surface renders a raw slug.
import type { StatusTone } from "@/components/ui/status-dot";
import type { RigChange, RigChangeKind, RigVersion } from "@/types";

/** Did this change's verification run pass? (The `passed` flag rides the
 *  open-ended verification record written by rig CI.) */
export function changeVerificationPassed(change: RigChange): boolean {
  return change.verification?.passed === true;
}

/** A verified `definition_edit` still sitting in `proposed` is awaiting a
 *  human promote (setup_append auto-merges, so it never lingers here). */
export function changeIsPromotable(change: RigChange): boolean {
  return change.kind === "definition_edit" && change.status === "proposed" && changeVerificationPassed(change);
}

export function rigChangeKindLabel(kind: RigChangeKind): string {
  return kind === "setup_append" ? "Setup command" : "Definition edit";
}

export type RigStatusView = {
  tone: StatusTone;
  label: string;
  /** Live states pulse the dot. */
  pulse: boolean;
  /** One-line plain-language gloss for tooltips / detail context. */
  description: string;
};

/** The status chip for a change, folding the verified-awaiting-promote case in
 *  (a `proposed` change that already passed reads as "Verified", not
 *  "Proposed"). */
export function rigChangeStatusView(change: RigChange): RigStatusView {
  switch (change.status) {
    case "verifying":
      return { tone: "running", label: "Verifying", pulse: true, description: "Replaying in a clean sandbox to confirm it reproduces." };
    case "merged":
      return { tone: "idle", label: "Merged", pulse: false, description: "Verified and folded into a new rig version." };
    case "rejected":
      return { tone: "failed", label: "Rejected", pulse: false, description: "Verification failed — the change did not reproduce cleanly." };
    case "failed":
      return { tone: "failed", label: "Verification error", pulse: false, description: "The verification run itself errored before it could decide." };
    case "proposed":
      return changeVerificationPassed(change)
        ? { tone: "idle", label: "Verified", pulse: false, description: "Passed verification — ready to promote into a new version." }
        : { tone: "queued", label: "Proposed", pulse: false, description: "Waiting to be verified against a clean sandbox." };
  }
}

/** The overall health of a rig version's most recent check run, for the list
 *  card + overview dot. `unknown` = never verified. */
export type RigCheckHealth = "passing" | "failing" | "unknown";

export function rigCheckHealthView(health: RigCheckHealth): RigStatusView {
  switch (health) {
    case "passing":
      return { tone: "idle", label: "Checks passing", pulse: false, description: "Every declared check exited zero on the last run." };
    case "failing":
      return { tone: "failed", label: "Check failing", pulse: false, description: "A declared check exited non-zero on the last run." };
    case "unknown":
      return { tone: "queued", label: "Not verified", pulse: false, description: "This version's checks have not been run yet." };
  }
}

/** Attribution string → a short human label. Domain stores `user:<subject>`,
 *  `session:<id>`, or `system`; render the actor, not the raw prefix. */
export function rigActorLabel(createdBy: string | null | undefined): string {
  if (!createdBy) {
    return "Unknown";
  }
  if (createdBy === "system") {
    return "System";
  }
  const [kind, ...rest] = createdBy.split(":");
  const id = rest.join(":");
  if (kind === "user") {
    return id || "A teammate";
  }
  if (kind === "session") {
    return id ? `Agent session ${id.slice(0, 8)}` : "An agent session";
  }
  return createdBy;
}

/** True when a version declares no checks — the overview should say so rather
 *  than imply an empty "passing". */
export function versionHasChecks(version: RigVersion | null | undefined): boolean {
  return (version?.checks.length ?? 0) > 0;
}
