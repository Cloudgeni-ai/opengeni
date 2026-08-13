import { OAUTH_MAX_RESPONSE_BYTES, pinnedFetch, readResponseJsonBounded } from "@opengeni/network";

import { runBoundedXaiOperation } from "./bounded-operation";
import {
  XAI_CLIENT_MODE,
  XAI_CLIENT_VERSION,
  XAI_SUBSCRIPTION_PROXY_BASE_URL,
  XAI_TOKEN_AUTH_HEADER_VALUE,
} from "./constants";
import { XaiSubscriptionReloginRequired, XaiSubscriptionTransientError } from "./errors";
import type { XaiFetchLike } from "./fetch";
import type { XaiSubscriptionTokenSnapshot } from "./request-context";

export type XaiProxyAuthContext = {
  clientVersion?: string;
  getToken: () => Promise<XaiSubscriptionTokenSnapshot>;
  refresh: () => Promise<XaiSubscriptionTokenSnapshot>;
};

const defaultProxyFetch: XaiFetchLike = async (input, init) =>
  await pinnedFetch(
    input,
    init,
    { environment: "production", integrationsAllowPrivateNetworkTargets: false },
    { label: "xAI subscription proxy", requireHttpsOutsideLocalTest: true },
  );

export async function fetchXaiProxyJson<T>(input: {
  path: string;
  context: XaiProxyAuthContext;
  fetch?: XaiFetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  baseUrl?: string;
  label: string;
}): Promise<T> {
  const fetchImpl = input.fetch ?? defaultProxyFetch;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const maxBytes = input.maxBytes ?? OAUTH_MAX_RESPONSE_BYTES;
  const url = `${(input.baseUrl ?? XAI_SUBSCRIPTION_PROXY_BASE_URL).replace(/\/+$/, "")}/${input.path.replace(/^\/+/, "")}`;
  const request = async (token: XaiSubscriptionTokenSnapshot, signal: AbortSignal) => {
    const headers = xaiSubscriptionProxyHeaders(token, input.context.clientVersion);
    return await fetchImpl(url, { method: "GET", redirect: "error", headers, signal });
  };
  const fetched = await runBoundedXaiOperation(async (signal) => {
    let response = await request(await input.context.getToken(), signal);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      response = await request(await input.context.refresh(), signal);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new XaiSubscriptionReloginRequired();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new XaiSubscriptionTransientError(
        `xAI ${input.label} failed (${response.status})`,
        response.status,
      );
    }
    return await readResponseJsonBounded<T>(response, maxBytes, `xAI ${input.label}`, { signal });
  }, timeoutMs);
  if (!fetched.ok) {
    throw new XaiSubscriptionTransientError(`xAI ${input.label} ${fetched.reason}`);
  }
  return fetched.value;
}

export function xaiSubscriptionProxyHeaders(
  token: XaiSubscriptionTokenSnapshot,
  clientVersion = XAI_CLIENT_VERSION,
): Headers {
  return new Headers({
    accept: "application/json",
    authorization: `Bearer ${token.accessToken}`,
    "user-agent": `opengeni/${clientVersion}`,
    "x-grok-client-version": clientVersion,
    "x-grok-client-identifier": "opengeni",
    "x-grok-client-mode": XAI_CLIENT_MODE,
    "x-authenticateresponse": "authenticate-response",
    "x-xai-token-auth": XAI_TOKEN_AUTH_HEADER_VALUE,
    "x-userid": token.userId,
    "x-grok-user-id": token.userId,
  });
}
