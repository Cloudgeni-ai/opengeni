import { describe, expect, test } from "bun:test";
import {
  decideCanonicalHumanSessionAdmission,
  type CanonicalHumanIdentityAdmissionSnapshot,
  type CanonicalHumanLoginBindingAdmissionSnapshot,
  type CanonicalHumanSessionAdmissionIntent,
} from "../src/auth/canonical-human-session-admission";

const identityId = "00000000-0000-4000-8000-000000000194";
const bindingId = "00000000-0000-4000-8000-000000000195";

function activeIdentity(): CanonicalHumanIdentityAdmissionSnapshot {
  return {
    id: identityId,
    status: "active",
    recoveryState: "ready",
    activeLoginBindingId: bindingId,
  };
}

function activeBinding(): CanonicalHumanLoginBindingAdmissionSnapshot {
  return {
    id: bindingId,
    identityId,
    status: "active",
  };
}

function decide(
  intent: CanonicalHumanSessionAdmissionIntent,
  identity = activeIdentity(),
  binding: CanonicalHumanLoginBindingAdmissionSnapshot | null = activeBinding(),
) {
  return decideCanonicalHumanSessionAdmission({ intent, identity, binding });
}

describe("canonical human session admission", () => {
  test("allows an ordinary session only for the active identity and its active binding", () => {
    expect(decide("ordinary_session")).toEqual({
      allowed: true,
      intent: "ordinary_session",
    });
  });

  test("allows binding synchronization under the same active authority", () => {
    expect(decide("binding_synchronization")).toEqual({
      allowed: true,
      intent: "binding_synchronization",
    });
  });

  test("allows an active identity to synchronize a previously unseen verified binding", () => {
    expect(decide("binding_synchronization", activeIdentity(), null)).toEqual({
      allowed: true,
      intent: "binding_synchronization",
    });
  });

  test("denies ordinary admission when no login binding is present", () => {
    expect(decide("ordinary_session", activeIdentity(), null)).toEqual({
      allowed: false,
      intent: "ordinary_session",
      code: "ordinary_binding_missing",
    });
  });

  test("denies ordinary admission while the identity requires recovery", () => {
    expect(
      decide("ordinary_session", {
        ...activeIdentity(),
        status: "recovery_required",
        recoveryState: "recovery_required",
        activeLoginBindingId: null,
      }),
    ).toEqual({
      allowed: false,
      intent: "ordinary_session",
      code: "ordinary_identity_not_active",
    });
  });

  test("denies recovery-pending synchronization without mutating either snapshot", () => {
    const identity: CanonicalHumanIdentityAdmissionSnapshot = {
      ...activeIdentity(),
      status: "recovery_required",
      recoveryState: "lost_factor",
      activeLoginBindingId: null,
    };
    const binding: CanonicalHumanLoginBindingAdmissionSnapshot = {
      ...activeBinding(),
      status: "recovery_pending",
    };
    const before = structuredClone({ identity, binding });

    expect(decide("binding_synchronization", identity, binding)).toEqual({
      allowed: false,
      intent: "binding_synchronization",
      code: "ordinary_identity_not_active",
    });
    expect({ identity, binding }).toEqual(before);
  });

  test("denies synchronization preflight before a recovery binding is inspected", () => {
    expect(
      decide(
        "binding_synchronization",
        {
          ...activeIdentity(),
          status: "recovery_required",
          recoveryState: "recovery_required",
          activeLoginBindingId: null,
        },
        null,
      ),
    ).toEqual({
      allowed: false,
      intent: "binding_synchronization",
      code: "ordinary_identity_not_active",
    });
  });

  test("denies a revoked binding", () => {
    expect(
      decide("ordinary_session", activeIdentity(), { ...activeBinding(), status: "revoked" }),
    ).toEqual({
      allowed: false,
      intent: "ordinary_session",
      code: "ordinary_binding_not_active",
    });
  });

  test("fails closed for every other non-active identity and binding status", () => {
    for (const status of ["disputed", "disabled"] as const) {
      expect(
        decide("ordinary_session", {
          ...activeIdentity(),
          status,
          recoveryState: status,
          activeLoginBindingId: null,
        }),
      ).toEqual({
        allowed: false,
        intent: "ordinary_session",
        code: "ordinary_identity_not_active",
      });
    }

    for (const status of ["recovery_pending", "stale", "disputed", "revoked"] as const) {
      expect(decide("ordinary_session", activeIdentity(), { ...activeBinding(), status })).toEqual({
        allowed: false,
        intent: "ordinary_session",
        code: "ordinary_binding_not_active",
      });
    }
  });

  test("denies a binding owned by another canonical identity", () => {
    expect(
      decide("ordinary_session", activeIdentity(), {
        ...activeBinding(),
        identityId: "00000000-0000-4000-8000-000000000196",
      }),
    ).toEqual({
      allowed: false,
      intent: "ordinary_session",
      code: "identity_binding_mismatch",
    });
  });

  test("allows another active binding owned by the same identity", () => {
    expect(
      decide("ordinary_session", activeIdentity(), {
        ...activeBinding(),
        id: "00000000-0000-4000-8000-000000000197",
      }),
    ).toEqual({
      allowed: true,
      intent: "ordinary_session",
    });
  });

  test("denies an active identity with no selected active factor", () => {
    expect(
      decide("ordinary_session", {
        ...activeIdentity(),
        activeLoginBindingId: null,
      }),
    ).toEqual({
      allowed: false,
      intent: "ordinary_session",
      code: "ordinary_active_binding_missing",
    });
  });

  test("allows explicit recovery completion only for required identity and pending binding state", () => {
    expect(
      decide(
        "recovery_completion",
        {
          ...activeIdentity(),
          status: "recovery_required",
          recoveryState: "recovery_required",
          activeLoginBindingId: null,
        },
        { ...activeBinding(), status: "recovery_pending" },
      ),
    ).toEqual({
      allowed: true,
      intent: "recovery_completion",
    });
  });

  test("also accepts lost-factor recovery as an explicit completion transition", () => {
    expect(
      decide(
        "recovery_completion",
        {
          ...activeIdentity(),
          status: "recovery_required",
          recoveryState: "lost_factor",
          activeLoginBindingId: null,
        },
        { ...activeBinding(), status: "recovery_pending" },
      ),
    ).toEqual({
      allowed: true,
      intent: "recovery_completion",
    });
  });

  test("denies recovery completion for an active identity or non-pending binding", () => {
    expect(decide("recovery_completion")).toEqual({
      allowed: false,
      intent: "recovery_completion",
      code: "recovery_identity_not_required",
    });
    expect(
      decide(
        "recovery_completion",
        {
          ...activeIdentity(),
          status: "recovery_required",
          recoveryState: "recovery_required",
          activeLoginBindingId: null,
        },
        activeBinding(),
      ),
    ).toEqual({
      allowed: false,
      intent: "recovery_completion",
      code: "recovery_binding_not_pending",
    });
  });

  test("denies recovery completion when required-state invariants are incomplete", () => {
    expect(
      decide(
        "recovery_completion",
        {
          ...activeIdentity(),
          status: "recovery_required",
          recoveryState: "ready",
          activeLoginBindingId: null,
        },
        { ...activeBinding(), status: "recovery_pending" },
      ),
    ).toEqual({
      allowed: false,
      intent: "recovery_completion",
      code: "recovery_state_not_required",
    });
    expect(
      decide(
        "recovery_completion",
        {
          ...activeIdentity(),
          status: "recovery_required",
          recoveryState: "recovery_required",
        },
        { ...activeBinding(), status: "recovery_pending" },
      ),
    ).toEqual({
      allowed: false,
      intent: "recovery_completion",
      code: "recovery_active_binding_present",
    });
    expect(
      decide(
        "recovery_completion",
        {
          ...activeIdentity(),
          status: "recovery_required",
          recoveryState: "recovery_required",
          activeLoginBindingId: null,
        },
        null,
      ),
    ).toEqual({
      allowed: false,
      intent: "recovery_completion",
      code: "recovery_binding_missing",
    });
  });
});
