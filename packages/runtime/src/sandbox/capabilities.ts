// Capability-descriptor access + boot-time registry invariants (module 03 §2.3).
//
// The CapabilityDescriptor type and the CAPABILITY_DESCRIPTORS table-as-data
// live in @opengeni/contracts (NOT here) so config can read them without an
// import cycle through runtime (ledger CR8). This module re-exports them for the
// registry's convenience and owns the boot-time self-test that keeps the table
// honest as providers are added.

import {
  CAPABILITY_DESCRIPTORS,
  DESKTOP_STREAM_PORT,
  SandboxBackend,
  type CapabilityDescriptor,
} from "@opengeni/contracts";

export { CAPABILITY_DESCRIPTORS, DESKTOP_STREAM_PORT };
export type { CapabilityDescriptor };

/**
 * Descriptor-table invariants, asserted once at registry build (and from a unit
 * test). This is the guardrail that keeps the static matrix internally coherent.
 * It validates the descriptor data only; the descriptor.backendId === SDK
 * client.backendId assertion (the deferred-from-P0.1 check) lives in
 * providers/index.ts because it must construct the real SDK clients.
 */
export function assertDescriptorRegistryInvariants(): void {
  for (const backend of SandboxBackend.options) {
    const descriptor = CAPABILITY_DESCRIPTORS[backend];
    if (!descriptor) {
      throw new Error(`No CapabilityDescriptor for backend "${backend}"`);
    }
    if (descriptor.backend !== backend) {
      throw new Error(`Descriptor.backend mismatch for "${backend}" (got "${descriptor.backend}")`);
    }

    // DesktopStream implies a non-"none" port-exposure mechanism (split-plane B
    // needs a way to surface 6080 to a viewer).
    if (descriptor.capabilities.DesktopStream.available && descriptor.portExposure.kind === "none") {
      throw new Error(`"${backend}" claims DesktopStream but portExposure.kind=none`);
    }

    // DesktopStream implies a transport, and a desktop transport implies the
    // capability is available (no half-declared desktop rows).
    if (descriptor.capabilities.DesktopStream.available && descriptor.capabilities.DesktopStream.transport === null) {
      throw new Error(`"${backend}" claims DesktopStream but transport is null`);
    }

    // Recording feasibility is the same Xvfb display as DesktopStream: a desktop
    // backend MUST be able to x11grab; a non-desktop backend MUST NOT claim it
    // (Recording.available == DesktopStream.available && os==linux — Part D).
    if (descriptor.capabilities.DesktopStream.available !== descriptor.capabilities.Recording.available) {
      throw new Error(
        `"${backend}" Recording.available (${descriptor.capabilities.Recording.available}) must equal DesktopStream.available (${descriptor.capabilities.DesktopStream.available})`,
      );
    }

    // Persistable backends are the only ones the lease can re-establish from an
    // envelope — they must carry a real snapshot mechanism.
    if (descriptor.persistable && descriptor.snapshot.kind === "none") {
      throw new Error(`"${backend}" persistable but snapshot.kind=none`);
    }

    // A nativeBucketMount backend must be desktop/headless-tier real (modal):
    // a dev/none tier cannot own a provider bucket mount.
    if (descriptor.nativeBucketMount && (descriptor.tier === "dev" || descriptor.tier === "none")) {
      throw new Error(`"${backend}" claims nativeBucketMount on tier=${descriptor.tier}`);
    }
  }
}
