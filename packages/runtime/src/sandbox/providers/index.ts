// The provider registry — PROVIDER_REGISTRY maps each SandboxBackend to its
// ProviderRegistration. This is the data structure createSandboxClient drives
// (replacing the old flat if/else chain). The module also owns the
// descriptor.backendId === SDK client.backendId assertion (deferred from P0.1):
// it must construct the real SDK clients, so it lives here rather than in the
// contracts-only capabilities self-test.

import type { Settings } from "@opengeni/config";
import {
  LEGACY_SANDBOX_PROVIDER_INSTANCE_ID_FIELDS,
  SANDBOX_PROVIDER_INSTANCE_ID_FIELDS_BY_BACKEND,
  SandboxBackend,
} from "@opengeni/contracts";
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
import type {
  ProviderImmutableImageBuildResult,
  ProviderRegistration,
  ProviderWorkspaceCapturePolicy,
} from "./types";
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
// construction — verified against the pinned @openai/agents-extensions 0.14.3), so this is
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
  const knownIdentityFields = new Set<string>(LEGACY_SANDBOX_PROVIDER_INSTANCE_ID_FIELDS);
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
    const identityFields = [...registration.instanceIdFields];
    const contractIdentityFields = [...SANDBOX_PROVIDER_INSTANCE_ID_FIELDS_BY_BACKEND[backend]];
    if (
      new Set(identityFields).size !== identityFields.length ||
      identityFields.some((field) => !knownIdentityFields.has(field)) ||
      identityFields.length !== contractIdentityFields.length ||
      identityFields.some((field, index) => field !== contractIdentityFields[index])
    ) {
      throw new Error(`Provider "${backend}" has an invalid live instance identity declaration`);
    }
    if (backend === "none") {
      // "none" has no SDK client (build returns undefined); the descriptor
      // backendId "none" is self-consistent.
      if (registration.descriptor.backendId !== "none") {
        throw new Error(
          `"none" descriptor.backendId must be "none" (got "${registration.descriptor.backendId}")`,
        );
      }
      if (registration.exactResumeMode !== "none") {
        throw new Error('Provider "none" must declare exactResumeMode="none"');
      }
      continue;
    }
    if (registration.exactResumeMode === "none") {
      throw new Error(`Provider "${backend}" cannot declare exactResumeMode="none"`);
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
    if (typeof (client as { resume?: unknown }).resume !== "function") {
      throw new Error(`Provider "${backend}" SDK client exposes no resume()`);
    }
    if (
      registration.exactResumeMode === "custom" &&
      typeof (client as { resumeExact?: unknown }).resumeExact !== "function"
    ) {
      throw new Error(`Provider "${backend}" requires but exposes no non-replacing resumeExact()`);
    }
    if (registration.continuity && registration.exactResumeMode !== "custom") {
      throw new Error(`Provider "${backend}" continuity requires custom exact resume`);
    }
    const capturePolicy = registration.workspaceCapturePolicy({});
    if ((backend === "selfhosted") !== (capturePolicy === null)) {
      throw new Error(
        `Provider "${backend}" must explicitly ${
          backend === "selfhosted" ? "omit" : "declare"
        } workspace capture`,
      );
    }
    if (capturePolicy?.strategy === "portable_tar" && capturePolicy.liveInstance !== "preserved") {
      throw new Error(`Provider "${backend}" portable tar capture must preserve its instance`);
    }
  }
}

export function providerWorkspaceCapturePolicy(
  backend: string,
  state: unknown,
): ProviderWorkspaceCapturePolicy | null {
  const registration = PROVIDER_REGISTRY[backend as SandboxBackend];
  return registration?.workspaceCapturePolicy(state) ?? null;
}

export function prepareProviderForTeardownAfterCapture(backend: string, session: unknown): void {
  PROVIDER_REGISTRY[backend as SandboxBackend]?.prepareForTeardownAfterCapture?.(session);
}

export function providerSupportsImmutableImageBuild(backend: SandboxBackend): boolean {
  return typeof PROVIDER_REGISTRY[backend].buildImmutableImage === "function";
}

export async function buildImmutableProviderImage(input: {
  backend: SandboxBackend;
  settings: Settings;
  session: unknown;
  requestId: string;
  timeoutMs: number;
}): Promise<ProviderImmutableImageBuildResult | null> {
  const build = PROVIDER_REGISTRY[input.backend].buildImmutableImage;
  if (!build) return null;
  return await build({
    settings: input.settings,
    session: input.session,
    requestId: input.requestId,
    timeoutMs: input.timeoutMs,
  });
}

// Boot-validate the registry once at module load: the descriptor-table self-
// test PLUS the descriptor.backendId === SDK client.backendId assertion (the
// deferred-from-P0.1 invariant). The SDK client constructors are pure option-
// stores (no network, no peer-dep require at construction), so this is a cheap,
// side-effect-free guard that fails fast on any drift between the static matrix
// and the installed @openai/agents-extensions.
assertProviderRegistryInvariants();

export type {
  ProviderRegistration,
  ProviderConstructionContext,
  ProviderExactResumeMode,
  ProviderImmutableImageBuildInput,
  ProviderImmutableImageBuildResult,
  ProviderWorkspaceCapturePolicy,
  ProviderWorkspaceCaptureTakeover,
} from "./types";
