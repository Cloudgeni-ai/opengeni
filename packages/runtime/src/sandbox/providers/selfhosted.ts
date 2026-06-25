import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import type { ProviderRegistration } from "./types";

// Bring-your-own-compute: the user's own machine, enrolled via the Rust agent,
// is reached over the NATS request/reply control plane (the agent subscribes to
// `agent.<workspace>.<agentId>.rpc`; the subject IS the registry). There is NO
// provider SDK and NO per-box credential — "the agent is the box".
//
// M1 registers ONLY the descriptor row + the backendId fence so `selfhosted`
// is a coherent 11th `SandboxBackend` (the descriptor/provider registry boot
// invariants pass). The NATS-backed `SelfhostedSandboxClient` — whose
// `create()`/`resume()` return a session presenting the structural surface
// (`exec`/`readFile`/`resolveExposedPort`/`serializeSessionState`) that
// Channel-A, the viewer, and computer-use consume unchanged — lands in M3.

/**
 * The minimal selfhosted SDK-client surface the registry needs at construction:
 * a stable `backendId` (the resume-fence field asserted against the descriptor's
 * `backendId` by `assertProviderRegistryInvariants`). The M3 NATS-backed client
 * supersedes this with the full structural session surface.
 */
class SelfhostedSandboxClient {
  readonly backendId = "selfhosted" as const;
}

export const selfhostedProvider: ProviderRegistration = {
  backend: "selfhosted",
  descriptor: CAPABILITY_DESCRIPTORS.selfhosted,
  // No per-box credentials: the machine is reached over the agent's own
  // enrollment. The enrollment-signing + relay-token secrets are deployment-level
  // (validated by the connectivity/enrollment milestones, M4/M5), not here.
  validateCredentials() {},
  build() {
    return new SelfhostedSandboxClient();
  },
};
