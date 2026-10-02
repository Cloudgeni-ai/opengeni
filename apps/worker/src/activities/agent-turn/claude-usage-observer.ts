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
  const observe = (providerId: string, response: Response, upstreamModelId?: string) => {
    const binding = captured.get(providerId);
    if (!binding) return;
    const { scope, ...identity } = binding;
    const captureKey = `${scope}:${identity.expectedConnectionId}:${identity.expectedCredentialVersion}`;
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
  return Object.assign(observe, {
    async prepareRequest(
      providerId: string,
      headers: Headers,
      resolve: (binding: {
        scope: Scope;
        expectedConnectionId: string;
        expectedCredentialVersion: number;
      }) => Promise<ClaudeRequestCredential | null>,
    ) {
      if (!managedProviderIds.has(providerId)) return headers;
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
      captured.set(providerId, { ...binding, token: credential.token });
      headers.set("authorization", `Bearer ${credential.token}`);
      headers.delete("x-api-key");
      return headers;
    },
    binding(providerId: string) {
      return captured.get(providerId);
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
