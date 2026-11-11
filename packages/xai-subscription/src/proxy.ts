import { OAUTH_MAX_RESPONSE_BYTES, pinnedFetch, readResponseJsonBounded } from "@opengeni/network";

import { runBoundedXaiOperation } from "./bounded-operation";
import { adoptXaiClientVersionFloor, currentXaiClientVersion } from "./client-version";
import {
  XAI_CLIENT_MODE,
  XAI_SUBSCRIPTION_PROXY_BASE_URL,
  XAI_TOKEN_AUTH_HEADER_VALUE,
} from "./constants";
import {
  readBoundedXaiErrorText,
  XaiSubscriptionClientOutdatedError,
  XaiSubscriptionReloginRequired,
  XaiSubscriptionTransientError,
} from "./errors";
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
  let presented = currentXaiClientVersion(input.context.clientVersion);
  const request = async (token: XaiSubscriptionTokenSnapshot, signal: AbortSignal) => {
    presented = currentXaiClientVersion(input.context.clientVersion);
    const headers = xaiSubscriptionProxyHeaders(token, presented);
    return await fetchImpl(url, { method: "GET", redirect: "error", headers, signal });
  };
  const fetched = await runBoundedXaiOperation(async (signal) => {
    let response = await request(await input.context.getToken(), signal);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      response = await request(await input.context.refresh(), signal);
    }
    let text = "";
    if (!response.ok) {
      text = await readBoundedXaiErrorText(response);
      if (adoptXaiClientVersionFloor(text, presented)) {
        // The provider named a newer minimum client: one retry presents it.
        response = await request(await input.context.getToken(), signal);
        text = response.ok ? "" : await readBoundedXaiErrorText(response);
      }
    }
    if (!response.ok) {
      const outdated = XaiSubscriptionClientOutdatedError.fromText(text, response.status);
      if (outdated) return { outdated };
      if (response.status === 401 || response.status === 403) {
        throw new XaiSubscriptionReloginRequired();
      }
      throw new XaiSubscriptionTransientError(
        `xAI ${input.label} failed (${response.status})`,
        response.status,
      );
    }
    return {
      value: await readResponseJsonBounded<T>(response, maxBytes, `xAI ${input.label}`, {
        signal,
      }),
    };
  }, timeoutMs);
  if (!fetched.ok) {
    throw new XaiSubscriptionTransientError(`xAI ${input.label} ${fetched.reason}`);
  }
  // The bounded operation reports any throw as a network error, so the one
  // refusal that must stay distinguishable leaves it as a value.
  if ("outdated" in fetched.value) throw fetched.value.outdated;
  return fetched.value.value;
}

export function xaiSubscriptionProxyHeaders(
  token: XaiSubscriptionTokenSnapshot,
  clientVersion = currentXaiClientVersion(),
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
