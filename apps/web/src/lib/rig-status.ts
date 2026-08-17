// Human-facing vocabulary for rigs. The domain uses enum slugs
// (`setup_append`, `definition_edit`, `proposed`, `verifying`, ...); this is the
// single boundary that translates them into sentence-case labels and maps them
// onto the shared StatusDot tone language. No rig surface renders a raw slug.
import type { StatusTone } from "@/components/ui/status-dot";
import type {
  RigChange,
  RigChangeKind,
  RigProviderImage,
  RigVersion,
  RigVersionSummary,
} from "@/types";

/** Did this change's verification run pass? (The `passed` flag rides the
 *  open-ended verification record written by rig CI.) */
export function changeVerificationPassed(change: RigChange): boolean {
  return change.verification?.passed === true;
}

/** A verified `definition_edit` still sitting in `proposed` is awaiting a
 *  human promote (setup_append auto-merges, so it never lingers here). */
export function changeIsPromotable(change: RigChange): boolean {
  return (
    change.kind === "definition_edit" &&
    change.status === "proposed" &&
    changeVerificationPassed(change)
  );
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
      return {
        tone: "running",
        label: "Verifying",
        pulse: true,
        description: "Replaying in a clean sandbox to confirm it reproduces.",
      };
    case "merged":
      return {
        tone: "idle",
        label: "Merged",
        pulse: false,
        description: "Verified and folded into a new rig version.",
      };
    case "rejected":
      return {
        tone: "failed",
        label: "Rejected",
        pulse: false,
        description: "Verification failed — the change did not reproduce cleanly.",
      };
    case "failed":
      return {
        tone: "failed",
        label: "Verification error",
        pulse: false,
        description: "The verification run itself errored before it could decide.",
      };
    case "proposed":
      return changeVerificationPassed(change)
        ? {
            tone: "idle",
            label: "Verified",
            pulse: false,
            description: "Passed verification — ready to promote into a new version.",
          }
        : {
            tone: "queued",
            label: "Proposed",
            pulse: false,
            description: "Waiting to be verified against a clean sandbox.",
          };
  }
}

/** The overall health of a rig version's most recent check run, for the list
 *  card + overview dot. `unknown` = never verified. */
export type RigCheckHealth = "passing" | "failing" | "unknown";

export function rigCheckHealthView(health: RigCheckHealth): RigStatusView {
  switch (health) {
    case "passing":
      return {
        tone: "idle",
        label: "Checks passing",
        pulse: false,
        description: "Every declared check exited zero on the last run.",
      };
    case "failing":
      return {
        tone: "failed",
        label: "Check failing",
        pulse: false,
        description: "A declared check exited non-zero on the last run.",
      };
    case "unknown":
      return {
        tone: "queued",
        label: "Not verified",
        pulse: false,
        description: "This version's checks have not been run yet.",
      };
  }
}

export function rigProviderImageStatusView(status: RigProviderImage["status"]): RigStatusView {
  switch (status) {
    case "building":
      return {
        tone: "running",
        label: "Preparing image",
        pulse: true,
        description: "Building and cold-boot checking this exact rig version.",
      };
    case "ready":
      return {
        tone: "idle",
        label: "Image ready",
        pulse: false,
        description: "Fresh sandboxes can start from the verified provider image.",
      };
    case "failed":
      return {
        tone: "failed",
        label: "Image build failed",
        pulse: false,
        description: "Fresh sandboxes use the safe setup fallback until this succeeds.",
      };
    case "unsupported":
      return {
        tone: "queued",
        label: "Uses setup fallback",
        pulse: false,
        description: "This provider does not support a prebuilt rig image.",
      };
  }
}

export function rigManagedSandboxReadinessView(
  readiness: RigVersionSummary["managedSandboxImage"],
): RigStatusView | null {
  if (!readiness) return null;
  switch (readiness.status) {
    case "unprepared":
      return {
        tone: "queued",
        label: "Fast startup not prepared yet",
        pulse: false,
        description: "You can start now; the first sandbox may run the complete rig setup.",
      };
    case "building":
      return {
        tone: "running",
        label: "Preparing fast startup",
        pulse: true,
        description: "You can start now; an immediate first sandbox may take longer.",
      };
    case "ready":
      return {
        tone: "idle",
        label: "Fast startup ready",
        pulse: false,
        description: "A fresh sandbox can use the verified image for this exact rig version.",
      };
    case "failed":
      return {
        tone: "failed",
        label: "Fast image unavailable",
        pulse: false,
        description: "The sandbox will run the complete setup instead of skipping rig content.",
      };
    case "unsupported":
      return {
        tone: "queued",
        label: "Setup runs at sandbox start",
        pulse: false,
        description: "This managed sandbox provider does not support a prebuilt rig image.",
      };
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
export function versionHasChecks(
  version: RigVersion | RigVersionSummary | null | undefined,
): boolean {
  if (!version) {
    return false;
  }
  return "checkCount" in version ? version.checkCount > 0 : version.checks.length > 0;
}
