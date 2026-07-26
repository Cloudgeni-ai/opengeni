// The uniform per-provider registration shape (module 03 §3.1).
//
// One file per provider implements ProviderRegistration; PROVIDER_REGISTRY maps
// each SandboxBackend to its registration. This replaces the flat if/else chain
// that createSandboxClient used to be.

import type { Settings } from "@opengeni/config";
import type { CapabilityDescriptor, SandboxBackend } from "@opengeni/contracts";

export interface ProviderConstructionContext {
  settings: Settings;
  /** The env map for the box (collectSandboxEnvironment / per-run environment). */
  environment: Record<string, string>;
  /**
   * Parsed exposed ports (config string -> number[]); already includes the
   * desktop stream port (6080) when this is a desktop tier with desktop enabled
   * and the provider cannot expose ports on demand (the merge happens in
   * createSandboxClient before build()).
   */
  exposedPorts: number[];
}

export interface ProviderRegistration {
  backend: SandboxBackend;
  descriptor: CapabilityDescriptor;
  /**
   * Validate that the settings carry the credentials/config this provider
   * REQUIRES. Throw SandboxConfigError on any missing/contradictory field.
   * Pure — no network. Called by both the factory and a deploy-time preflight.
   * The factory calls this before build(), so build() may assume valid settings.
   */
  validateCredentials(settings: Settings): void;
  /**
   * Build the raw SDK SandboxClient. Returns undefined ONLY for "none".
   * The factory calls validateCredentials() first, so build() can assume valid.
   */
  build(ctx: ProviderConstructionContext): unknown;
}
