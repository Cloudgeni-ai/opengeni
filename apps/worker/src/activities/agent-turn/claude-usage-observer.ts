import {
  emptyClaudeUsage,
  mergeClaudeUsage,
  parseClaudeUsageHeaders,
  type parseModelProvidersJson,
  type ClaudeUsageObservation,
} from "@opengeni/config";

type Scope = "workspace" | "organization";
export type CapturedClaudeUsage = {
  token: string;
  expectedConnectionId: string;
  expectedCredentialVersion: number;
  observation?: ClaudeUsageObservation;
  refresh?: { status: "reconnect"; checkedAt: string };
};

/** Capture the exact credential before requests; replacement fences late responses. */
export async function createClaudeUsageObserver(
  providers: ReturnType<typeof parseModelProvidersJson>,
  latest: Map<Scope, CapturedClaudeUsage>,
  readCredential: (scope: Scope) => Promise<{
    token: string;
    connectionId: string;
    credentialVersion: number;
  } | null>,
) {
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
  const observe = (providerId: string, response: Response) => {
    const binding = captured.get(providerId);
    if (!binding) return;
    const { scope, ...identity } = binding;
    const previous = latest.get(scope);
    let observation = parseClaudeUsageHeaders(response.headers);
    if (observation && previous?.observation) {
      const merged = mergeClaudeUsage(
        mergeClaudeUsage(emptyClaudeUsage(binding.expectedCredentialVersion), previous.observation),
        observation,
      );
      observation = {
        windows: merged.windows,
        observedAt: merged.observedAt!,
        source: merged.source!,
      };
    }
    if (observation || response.status === 401)
      latest.set(scope, {
        ...identity,
        ...(previous?.observation && !observation ? { observation: previous.observation } : {}),
        ...(observation ? { observation } : {}),
        ...(response.status === 401
          ? { refresh: { status: "reconnect", checkedAt: new Date().toISOString() } }
          : {}),
      });
  };
  return Object.assign(observe, {
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
