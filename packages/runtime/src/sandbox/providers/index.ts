// The provider registry — PROVIDER_REGISTRY maps each SandboxBackend to its
// ProviderRegistration. This is the data structure createSandboxClient drives
// (replacing the old flat if/else chain). The module also owns the
// descriptor.backendId === SDK client.backendId assertion (deferred from P0.1):
// it must construct the real SDK clients, so it lives here rather than in the
// contracts-only capabilities self-test.

import type { Settings } from "@opengeni/config";
import { SandboxBackend } from "@opengeni/contracts";
import { assertDescriptorRegistryInvariants } from "../capabilities";
import { blaxelProvider } from "./blaxel";
import { cloudflareProvider } from "./cloudflare";
import { daytonaProvider } from "./daytona";
import { dockerProvider } from "./docker";
import { e2bProvider } from "./e2b";
import { localProvider } from "./local";
import { modalProvider } from "./modal";
import { noneProvider } from "./none";
import { runloopProvider } from "./runloop";
import { selfhostedProvider } from "./selfhosted";
import type { ProviderRegistration } from "./types";
import { vercelProvider } from "./vercel";

export const PROVIDER_REGISTRY: Record<SandboxBackend, ProviderRegistration> = {
  docker: dockerProvider,
  modal: modalProvider,
  local: localProvider,
  none: noneProvider,
  daytona: daytonaProvider,
  runloop: runloopProvider,
  e2b: e2bProvider,
  blaxel: blaxelProvider,
  cloudflare: cloudflareProvider,
  vercel: vercelProvider,
  selfhosted: selfhostedProvider,
};

// Stub settings carrying every per-provider credential, used ONLY by the
// boot-time backendId assertion to construct each client without tripping
// validateCredentials. The SDK client constructors are pure option-stores (the
// underlying provider SDK is required lazily at create()/resume() time, never at
// construction — verified against @openai/agents-extensions 0.11.6), so this is
// safe with no provider peer dep installed and no network.
const ASSERTION_STUB_SETTINGS = {
  dockerImage: "opengeni-sandbox:local",
  modalAppName: "opengeni-sandbox",
  modalTimeoutSeconds: 900,
  daytonaApiKey: "stub",
  runloopApiKey: "stub",
  runloopTunnel: true,
  e2bApiKey: "stub",
  blaxelApiKey: "stub",
  cloudflareWorkerUrl: "https://stub.example.com",
  vercelToken: "stub",
  vercelProjectId: "stub",
} as unknown as Settings;

/**
 * Assert the descriptor table AND that each registered provider's SDK client
 * reports the backendId its descriptor claims. The latter is the
 * deferred-from-P0.1 invariant — it can only run here because it constructs the
 * real clients. Called once at registry build (and from a unit test).
 */
export function assertProviderRegistryInvariants(): void {
  assertDescriptorRegistryInvariants();
  for (const backend of SandboxBackend.options) {
    const registration = PROVIDER_REGISTRY[backend];
    if (registration.backend !== backend) {
      throw new Error(
        `PROVIDER_REGISTRY["${backend}"].backend mismatch (got "${registration.backend}")`,
      );
    }
    if (registration.descriptor.backend !== backend) {
      throw new Error(
        `PROVIDER_REGISTRY["${backend}"].descriptor.backend mismatch (got "${registration.descriptor.backend}")`,
      );
    }
    if (backend === "none") {
      // "none" has no SDK client (build returns undefined); the descriptor
      // backendId "none" is self-consistent.
      if (registration.descriptor.backendId !== "none") {
        throw new Error(
          `"none" descriptor.backendId must be "none" (got "${registration.descriptor.backendId}")`,
        );
      }
      continue;
    }
    const client = registration.build({
      settings: ASSERTION_STUB_SETTINGS,
      environment: {},
      exposedPorts: [],
    });
    const sdkBackendId = (client as { backendId?: unknown } | undefined)?.backendId;
    if (typeof sdkBackendId !== "string") {
      throw new Error(`Provider "${backend}" SDK client has no string backendId`);
    }
    if (sdkBackendId !== registration.descriptor.backendId) {
      throw new Error(
        `Provider "${backend}" backendId mismatch: descriptor.backendId="${registration.descriptor.backendId}" but SDK client.backendId="${sdkBackendId}"`,
      );
    }
  }
}

// Boot-validate the registry once at module load: the descriptor-table self-
// test PLUS the descriptor.backendId === SDK client.backendId assertion (the
// deferred-from-P0.1 invariant). The SDK client constructors are pure option-
// stores (no network, no peer-dep require at construction), so this is a cheap,
// side-effect-free guard that fails fast on any drift between the static matrix
// and the installed @openai/agents-extensions.
assertProviderRegistryInvariants();

export type { ProviderRegistration, ProviderConstructionContext } from "./types";
