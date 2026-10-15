import type { Settings } from "@opengeni/config";
import {
  DestinationPolicyError,
  ResponseBodyLimitError,
  isLocalTestEnvironment,
  pinnedFetch,
  readResponseTextBounded,
  validateHttpUrl,
  type OutboundNetworkSettings,
} from "@opengeni/network";
import {
  RemoteVaultTransportError,
  VaultProviderError,
  createRemoteVaultProvider,
  type RemoteVaultTransport,
} from "@opengeni/vaults";
import type { ExternalVaultProviderFactories } from "./external-provider-connections";

/** Shared by API and worker. No credential-bearing request uses ambient fetch. */
export function createPinnedRemoteVaultTransport(
  settings: OutboundNetworkSettings,
  fetchImpl: typeof pinnedFetch = pinnedFetch,
): RemoteVaultTransport {
  return {
    async post(request) {
      if (request.signal?.aborted) throw new RemoteVaultTransportError("aborted", false);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, request.timeoutMs);
      const onAbort = () => controller.abort();
      request.signal?.addEventListener("abort", onAbort, { once: true });
      let rejectAborted: (() => void) | undefined;
      try {
        // The deadline includes DNS, connect, headers and the complete body.
        // Racing DNS does not retry it: pinnedFetch receives the aborted signal
        // and cannot send a later request if lookup completes after the deadline.
        const aborted = new Promise<never>((_resolve, reject) => {
          rejectAborted = () =>
            reject(new RemoteVaultTransportError(timedOut ? "timeout" : "aborted", true));
          controller.signal.addEventListener("abort", rejectAborted, { once: true });
          if (controller.signal.aborted) rejectAborted();
        });
        const exchange = async () => {
          const response = await fetchImpl(
            request.url,
            {
              method: "POST",
              headers: { ...request.headers },
              body: request.body,
              redirect: "manual",
              signal: controller.signal,
            },
            settings,
            { label: "Vault provider", requireHttpsOutsideLocalTest: true },
          );
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => undefined);
            throw new RemoteVaultTransportError("redirect", true);
          }
          return {
            status: response.status,
            headers: response.headers,
            body: await readResponseTextBounded(
              response,
              request.maxResponseBytes,
              "Vault provider",
              { signal: controller.signal },
            ),
          };
        };
        return await Promise.race([exchange(), aborted]);
      } catch (error) {
        if (error instanceof RemoteVaultTransportError) throw error;
        if (error instanceof DestinationPolicyError)
          throw new RemoteVaultTransportError("refused", false);
        if (error instanceof ResponseBodyLimitError)
          throw new RemoteVaultTransportError("too_large", true);
        throw new RemoteVaultTransportError(
          timedOut ? "timeout" : controller.signal.aborted ? "aborted" : "network",
          true,
        );
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        if (rejectAborted) controller.signal.removeEventListener("abort", rejectAborted);
      }
    },
  };
}

export function createRemoteExternalVaultFactories(
  settings: Pick<Settings, "environment" | "integrationsAllowPrivateNetworkTargets">,
): ExternalVaultProviderFactories {
  const transport = createPinnedRemoteVaultTransport(settings);
  const factory: NonNullable<ExternalVaultProviderFactories["external"]> = async ({
    credentials,
    operations,
  }) => {
    if (credentials.provider !== "external" && credentials.provider !== "bitwarden")
      throw new VaultProviderError("provider_auth_invalid", "Vault provider does not match.");
    let endpoint: string;
    try {
      endpoint = validateHttpUrl(credentials.endpoint, {
        allowLoopbackHttp: isLocalTestEnvironment(settings.environment),
        label: "Vault provider",
      });
    } catch {
      throw new VaultProviderError(
        "provider_auth_invalid",
        "Use an HTTPS vault endpoint without URL credentials or a fragment.",
      );
    }
    return {
      credentials: { ...credentials, endpoint },
      provider: createRemoteVaultProvider({
        provider: credentials.provider,
        endpoint,
        signingSecret: credentials.signingSecret,
        transport,
        allowInsecureHttp: isLocalTestEnvironment(settings.environment),
        ...(operations ? { operations } : {}),
      }),
    };
  };
  return { external: factory, bitwarden: factory };
}
