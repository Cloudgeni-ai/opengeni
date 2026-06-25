// Bring-your-own-compute: the user's own machine, enrolled via the Rust agent,
// is reached over the NATS request/reply control plane (the agent subscribes to
// `agent.<workspace>.<agentId>.rpc`; the subject IS the registry). There is NO
// provider SDK and NO per-box credential — "the agent is the box".
//
// M3 ships the REAL `SelfhostedSandboxClient`: its `create()`/`resume()` return a
// `SelfhostedSession` presenting the structural surface (`exec`/`readFile`/
// `writeFile`/`resolveExposedPort`/`serializeSessionState`) that Channel-A, the
// viewer, and computer-use consume unchanged — backed by a `ControlRpc` seam
// (request/reply encoded via `@opengeni/agent-proto`) instead of a provider SDK.
// `serializeSessionState`/`deserializeSessionState` round-trip `{agentId}` ONLY:
// resume = re-address the live subject, never a cold re-create (the machine is
// not recreatable). The live NATS request/reply transport + Accounts land in M4
// behind the SAME `ControlRpc`.

import type { Settings } from "@opengeni/config";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import {
  NatsControlRpc,
  type ControlRpc,
  type NatsRequestConnection,
} from "../selfhosted/control-rpc";
import {
  SelfhostedSandboxClient,
  type SelfhostedRelayConfig,
} from "../selfhosted/session";
import type { ProviderRegistration } from "./types";

/**
 * Resolve the relay-URL shape config from settings. M3 has NO dedicated relay
 * config field yet (the relay tier + its config land in M8 via ops-repo IaC), so
 * this defaults to a stub host — the session returns the relay URL SHAPE, which
 * is all M3 needs (`resolveExposedPort` returns `{host, port, tls, query}`). M8
 * threads the real relay host behind this seam with NO session change.
 */
function resolveRelayConfig(_settings: Settings): SelfhostedRelayConfig {
  // The relay host is a future ops-repo-provisioned value. Until M8 wires it into
  // Settings, M3 uses a stable placeholder so the URL shape is well-formed.
  return { host: "relay.opengeni.local", port: 443, tls: true };
}

/**
 * The default `ControlRpc` factory for a registry-built client: a
 * `NatsControlRpc` whose connection factory returns null — there is NO live NATS
 * connection wired into the agent-loop-free runtime leaf at build() time (the
 * API/worker inject the live `@opengeni/events` connection per request in M4).
 * A null connection surfaces `agent_offline` on every op rather than throwing at
 * construction, so boot never requires a live NATS — exactly the M3 ruling.
 */
function defaultControlRpcFactory(): ControlRpc {
  return new NatsControlRpc(async (): Promise<NatsRequestConnection | null> => null);
}

export const selfhostedProvider: ProviderRegistration = {
  backend: "selfhosted",
  descriptor: CAPABILITY_DESCRIPTORS.selfhosted,
  /**
   * No per-box credentials: the machine is reached over the agent's own
   * enrollment. The enrollment-signing + relay-token secrets are deployment-level
   * config that lands with the connectivity/enrollment milestones (M4/M5) — and
   * the whole feature is gated by a `sandboxSelfhostedEnabled` flag (default off)
   * that does not yet exist in Settings. So validation is LENIENT (no-op) in M3:
   * boot must never break, and there is nothing per-box to validate. M4/M5 add
   * the (flag-gated) signing/relay presence checks here behind the same seam.
   */
  validateCredentials() {},
  /**
   * Build the registry client. `create()`/`resume()` bind a `SelfhostedSession`
   * to the agent subject; the per-request `{workspaceId, agentId, controlRpc}`
   * are supplied by the resume path (the lease's enrollment) — the registry
   * client carries the relay config + the default (offline-until-M4) ControlRpc
   * factory and a backendId-correct surface for `assertProviderRegistryInvariants`.
   */
  build({ settings }) {
    return new SelfhostedSandboxClient({
      // The workspaceId is bound per-request by the resume path (the API/worker
      // construct a request-scoped client with the lease's workspace + a live
      // ControlRpc). The registry-built client is the boot/assertion shape; an
      // empty workspaceId is fine until a session is bound with a real one.
      workspaceId: "",
      relay: resolveRelayConfig(settings),
      controlRpcFactory: defaultControlRpcFactory,
    });
  },
};
