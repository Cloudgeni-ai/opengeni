import { createBrowserAccountsClient } from "@opengeni/sdk/accounts";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";
import {
  ApiError,
  apiBaseUrl,
  apiErrorFromResponseBody,
  currentManagedActorEpoch,
  managedActorFetch,
} from "@/api";

function signInResponseError(status: number, body: string): ApiError {
  const nested = apiErrorFromResponseBody(status, body);
  if (nested.code) return nested;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return new ApiError(status, body, {
      ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
      ...(parsed.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
    });
  } catch {
    return nested;
  }
}

// Browser-only contract agreed with the backend owner. No workspace, subject,
// or user selector is accepted: the server resolves the canonical cookie actor.
export type SignInMethods = {
  email: string;
  emailVerified: boolean;
  identityRevision: number;
  freshAuthenticationRequired: boolean;
  methods: Array<{
    provider: "credential" | "google" | "github";
    connected: boolean;
    available: boolean;
    canDisconnect: boolean;
    implicitRelinkingSuppressed: boolean;
  }>;
};
export type SignInChangeResult = {
  reauthenticationRequired: true;
  notification: "sent" | "failed" | "outcome_unknown";
};
export type SignInCommand = {
  operationId: string;
  expectedIdentityRevision: number;
} & ({ provider: "google" | "github" } | { newPassword: string; currentPassword?: string });
export type PreparedSignInCommand = {
  path: "connect" | "disconnect" | "password";
  body: SignInCommand;
  headers: Record<string, string>;
};

export function createSignInMethodsApi(sessionSetMode: "legacy" | "dual" | "broker") {
  const actorEpoch = currentManagedActorEpoch();
  const assertActor = () => {
    if (currentManagedActorEpoch() !== actorEpoch)
      throw new DOMException("The browser account changed", "AbortError");
  };
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    assertActor();
    const response = await managedActorFetch(`${apiBaseUrl}/v1/auth/sign-in-methods${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "content-type": "application/json",
        [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        ...init?.headers,
      },
    });
    const body = await response.text();
    assertActor();
    if (!response.ok) throw signInResponseError(response.status, body);
    return JSON.parse(body) as T;
  }
  return {
    list: () => request<SignInMethods>(""),
    async prepare(
      path: PreparedSignInCommand["path"],
      body: SignInCommand,
    ): Promise<PreparedSignInCommand> {
      assertActor();
      const headers: Record<string, string> = {};
      if (sessionSetMode !== "legacy") {
        const projection = await createBrowserAccountsClient({
          baseUrl: apiBaseUrl,
          fetch: managedActorFetch,
        }).getSessionSet();
        assertActor();
        if (!projection.selectedSlotId || projection.actorEpoch !== actorEpoch)
          throw new DOMException("The browser account changed", "AbortError");
        headers["x-opengeni-session-csrf"] = projection.csrfToken;
        headers["x-opengeni-actor-epoch"] = projection.actorEpoch;
      }
      return { path, body, headers };
    },
    execute: <T extends SignInChangeResult | { url: string }>(command: PreparedSignInCommand) =>
      request<T>(`/${command.path}`, {
        method: "POST",
        headers: command.headers,
        body: JSON.stringify(command.body),
      }),
  };
}
