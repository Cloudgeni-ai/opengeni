import type {
  CanonicalHumanIdentityStatus,
  CanonicalHumanLoginBindingStatus,
  CanonicalHumanRecoveryState,
} from "@opengeni/contracts/canonical-human-identities";

export type CanonicalHumanSessionAdmissionIntent =
  | "ordinary_session"
  | "binding_synchronization"
  | "recovery_completion";

export type CanonicalHumanIdentityAdmissionSnapshot = {
  readonly id: string;
  readonly status: CanonicalHumanIdentityStatus;
  readonly recoveryState: CanonicalHumanRecoveryState;
  readonly activeLoginBindingId: string | null;
};

export type CanonicalHumanLoginBindingAdmissionSnapshot = {
  readonly id: string;
  readonly identityId: string;
  readonly status: CanonicalHumanLoginBindingStatus;
};

export type CanonicalHumanSessionAdmissionDenialCode =
  | "identity_binding_mismatch"
  | "ordinary_identity_not_active"
  | "ordinary_identity_not_ready"
  | "ordinary_binding_missing"
  | "ordinary_binding_not_active"
  | "ordinary_active_binding_missing"
  | "recovery_identity_not_required"
  | "recovery_state_not_required"
  | "recovery_active_binding_present"
  | "recovery_binding_missing"
  | "recovery_binding_not_pending";

export type CanonicalHumanSessionAdmissionDecision =
  | {
      allowed: true;
      intent: CanonicalHumanSessionAdmissionIntent;
    }
  | {
      allowed: false;
      intent: CanonicalHumanSessionAdmissionIntent;
      code: CanonicalHumanSessionAdmissionDenialCode;
    };

export function decideCanonicalHumanSessionAdmission(input: {
  intent: CanonicalHumanSessionAdmissionIntent;
  identity: CanonicalHumanIdentityAdmissionSnapshot;
  binding: CanonicalHumanLoginBindingAdmissionSnapshot | null;
}): CanonicalHumanSessionAdmissionDecision {
  if (input.binding && input.binding.identityId !== input.identity.id) {
    return denied(input.intent, "identity_binding_mismatch");
  }

  if (input.intent === "recovery_completion") {
    return decideRecoveryCompletion(input.identity, input.binding);
  }

  if (input.identity.status !== "active") {
    return denied(input.intent, "ordinary_identity_not_active");
  }
  if (input.identity.recoveryState !== "ready") {
    return denied(input.intent, "ordinary_identity_not_ready");
  }
  if (input.intent === "binding_synchronization" && input.binding === null) {
    return allowed(input.intent);
  }
  if (input.binding === null) {
    return denied(input.intent, "ordinary_binding_missing");
  }
  if (input.binding.status !== "active") {
    return denied(input.intent, "ordinary_binding_not_active");
  }
  if (input.identity.activeLoginBindingId === null) {
    return denied(input.intent, "ordinary_active_binding_missing");
  }
  return allowed(input.intent);
}

function decideRecoveryCompletion(
  identity: CanonicalHumanIdentityAdmissionSnapshot,
  binding: CanonicalHumanLoginBindingAdmissionSnapshot | null,
): CanonicalHumanSessionAdmissionDecision {
  if (identity.status !== "recovery_required") {
    return denied("recovery_completion", "recovery_identity_not_required");
  }
  if (identity.recoveryState !== "recovery_required" && identity.recoveryState !== "lost_factor") {
    return denied("recovery_completion", "recovery_state_not_required");
  }
  if (identity.activeLoginBindingId !== null) {
    return denied("recovery_completion", "recovery_active_binding_present");
  }
  if (binding === null) {
    return denied("recovery_completion", "recovery_binding_missing");
  }
  if (binding.status !== "recovery_pending") {
    return denied("recovery_completion", "recovery_binding_not_pending");
  }
  return allowed("recovery_completion");
}

function allowed(
  intent: CanonicalHumanSessionAdmissionIntent,
): CanonicalHumanSessionAdmissionDecision {
  return { allowed: true, intent };
}

function denied(
  intent: CanonicalHumanSessionAdmissionIntent,
  code: CanonicalHumanSessionAdmissionDenialCode,
): CanonicalHumanSessionAdmissionDecision {
  return { allowed: false, intent, code };
}
