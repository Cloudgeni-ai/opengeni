import { createHash } from "node:crypto";
import {
  emptyClaudeUsage,
  mergeClaudeUsage,
  parseClaudeUsageHeaders,
  type parseModelProvidersJson,
  type ClaudeUsageObservation,
} from "@opengeni/config";

type Scope = "workspace" | "organization";
type ClaudeRequestCredential = {
  token: string;
  connectionId: string;
  credentialVersion: number;
};
export class ClaudeSubscriptionConnectionUnavailable extends Error {
  readonly status = 409;
  readonly code = "claude_subscription_connection_changed";
  constructor() {
    super(
      "Claude connection changed or was disconnected. Start a new turn with the current connection.",
    );
  }
}
export type CapturedClaudeUsage = {
  scope: Scope;
  token: string;
  expectedConnectionId: string;
  expectedCredentialVersion: number;
  observation?: ClaudeUsageObservation;
  refresh?: { status: "reconnect"; checkedAt: string };
};

/** Capture the exact credential before requests; replacement fences late responses. */
export async function createClaudeUsageObserver(
  providers: ReturnType<typeof parseModelProvidersJson>,
  latest: Map<string, CapturedClaudeUsage>,
  readCredential: (scope: Scope) => Promise<{
    token: string;
    connectionId: string;
    credentialVersion: number;
  } | null>,
) {
  const managedProviderIds = new Set(
    providers
      .filter(
        (provider) =>
          provider.kind === "claude-subscription-workspace" ||
          provider.kind === "claude-subscription-organization",
      )
      .map((provider) => provider.id),
  );
  const bindings = await Promise.all(
    providers
      .filter(
        (provider) =>
          provider.kind === "claude-subscription-workspace" ||
          provider.kind === "claude-subscription-organization",
      )
      .map(async (provider) => {
        const scope: Scope =
          provider.kind === "claude-subscription-workspace" ? "workspace" : "organization";
        const binding = provider.anthropic?.credentialBinding;
        if (binding && provider.apiKey)
          return [
            provider.id,
            {
              scope,
              token: provider.apiKey,
              expectedConnectionId: binding.connectionId,
              expectedCredentialVersion: binding.credentialVersion,
            },
          ] as const;
        const credential = await readCredential(scope).catch(() => null);
        if (!credential || credential.token !== provider.apiKey) return null;
        return [
          provider.id,
          {
            scope,
            token: credential.token,
            expectedConnectionId: credential.connectionId,
            expectedCredentialVersion: credential.credentialVersion,
          },
        ] as const;
      }),
  );
  const captured = new Map(bindings.filter((binding) => binding !== null));
  const observeBinding = (
    binding:
      | Pick<
          CapturedClaudeUsage,
          "scope" | "token" | "expectedConnectionId" | "expectedCredentialVersion"
        >
      | undefined,
    response: Response,
    upstreamModelId?: string,
    requestToken?: string | null,
  ) => {
    if (requestToken === null) return;
    if (!binding) return;
    const { scope, ...capturedIdentity } = binding;
    const identity = { ...capturedIdentity, token: requestToken ?? capturedIdentity.token };
    // Same-generation OAuth renewal can overlap an older request. Never attach
    // its authentication failure to the newly renewed token or merge the two.
    const tokenKey = createHash("sha256").update(identity.token).digest("hex");
    const captureKey = `${scope}:${identity.expectedConnectionId}:${identity.expectedCredentialVersion}:${tokenKey}`;
    const previous = latest.get(captureKey);
    let observation = parseClaudeUsageHeaders(response.headers, new Date(), upstreamModelId);
    if (observation && previous?.observation) {
      const merged = mergeClaudeUsage(
        mergeClaudeUsage(emptyClaudeUsage(binding.expectedCredentialVersion), previous.observation),
        observation,
      );
      observation = {
        windows: merged.windows,
        observedAt: merged.observedAt!,
        source: merged.source!,
        requestStatus: merged.requestStatus ?? null,
        requestRestrictions: merged.requestRestrictions ?? [],
      };
    }
    if (observation || response.status === 401)
      latest.set(captureKey, {
        scope,
        ...identity,
        ...(previous?.observation && !observation ? { observation: previous.observation } : {}),
        ...(observation ? { observation } : {}),
        ...(response.status === 401
          ? { refresh: { status: "reconnect", checkedAt: new Date().toISOString() } }
          : {}),
      });
  };
  const observe = (
    providerId: string,
    response: Response,
    upstreamModelId?: string,
    requestToken?: string | null,
  ) => observeBinding(captured.get(providerId), response, upstreamModelId, requestToken);
  const prepareRequestWithObserver = async (
    providerId: string,
    headers: Headers,
    resolve: (binding: {
      scope: Scope;
      expectedConnectionId: string;
      expectedCredentialVersion: number;
    }) => Promise<ClaudeRequestCredential | null>,
  ) => {
    if (!managedProviderIds.has(providerId)) return { headers, observe };
    const binding = captured.get(providerId);
    if (!binding) throw new ClaudeSubscriptionConnectionUnavailable();
    const credential = await resolve({
      scope: binding.scope,
      expectedConnectionId: binding.expectedConnectionId,
      expectedCredentialVersion: binding.expectedCredentialVersion,
    });
    if (
      !credential ||
      credential.connectionId !== binding.expectedConnectionId ||
      credential.credentialVersion !== binding.expectedCredentialVersion
    )
      throw new ClaudeSubscriptionConnectionUnavailable();
    const dispatched = Object.freeze({ ...binding, token: credential.token });
    captured.set(providerId, dispatched);
    headers.set("authorization", `Bearer ${credential.token}`);
    headers.delete("x-api-key");
    return {
      headers,
      observe: (
        _providerId: string,
        response: Response,
        upstreamModelId?: string,
        requestToken?: string | null,
      ) => observeBinding(dispatched, response, upstreamModelId, requestToken),
    };
  };
  return Object.assign(observe, {
    prepareRequestWithObserver,
    async prepareRequest(...args: Parameters<typeof prepareRequestWithObserver>) {
      return (await prepareRequestWithObserver(...args)).headers;
    },
    binding(providerId: string) {
      const binding = captured.get(providerId);
      return binding ? { ...binding } : undefined;
    },
    renew(
      providerId: string,
      credential: {
        token: string;
        connectionId: string;
        credentialVersion: number;
      },
    ) {
      const binding = captured.get(providerId);
      if (
        binding &&
        binding.expectedConnectionId === credential.connectionId &&
        binding.expectedCredentialVersion === credential.credentialVersion
      )
        captured.set(providerId, { ...binding, token: credential.token });
    },
  });
}
