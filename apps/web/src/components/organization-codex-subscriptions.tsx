import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { beginModelConnectJourney } from "@/lib/integration-connect-analytics";
import type {
  CodexAccount,
  CodexConnectPoll,
  CodexConnectStart,
  OrganizationCodexAccountsResponse,
} from "@opengeni/sdk";
import { pollDeviceAuthorization } from "@opengeni/connect";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { codexAccountName, planLabel } from "@/components/codex-connection";
import { apiErrorAdvice, userErrorText } from "@/lib/api-error";
import { invalidateSharedQueries, useSharedQuery } from "@/lib/shared-query";

// The organization's shared Codex (ChatGPT) accounts: the data and every
// mutation. Organization settings > Models presents them with the same rows
// and account page anatomy as a workspace.

export type OrganizationCodexSubscriptions = ReturnType<typeof useOrganizationCodexSubscriptions>;

/** Shared-cache key for an organization's own Codex accounts. */
export const organizationCodexAccountsQueryKey = (organizationId: string) =>
  ["codex-accounts", "organization", organizationId] as const;

export function useOrganizationCodexSubscriptions({
  organizationId,
  client,
  enabled = true,
}: {
  organizationId: string;
  client: OpenGeniBrowserClient;
  /** False for people who can't read the organization's accounts: nothing is read. */
  enabled?: boolean;
}) {
  // Shared, client-scoped: revisiting organization settings renders the
  // retained accounts at once and re-reads in the background.
  const query = useSharedQuery<OrganizationCodexAccountsResponse>(
    client,
    organizationCodexAccountsQueryKey(organizationId),
    () =>
      client.requestJson<OrganizationCodexAccountsResponse>(
        "GET",
        `/v1/organizations/${organizationId}/codex/accounts`,
      ),
    { enabled },
  );
  const data = query.error ? null : query.data;
  const loading = query.loading;
  // Shown under "Couldn't load ..." as what to do; never the raw API message.
  const loadError = query.error ? apiErrorAdvice(query.error) : null;
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    userCode: string;
    verificationUri: string;
  } | null>(null);
  const cancelled = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);

  // Organization accounts feed every workspace that inherits them, so an
  // account change invalidates every retained Codex list for this client.
  const refresh = useCallback(async () => {
    if (!enabled) return;
    await invalidateSharedQueries(client, ["codex-accounts"]);
  }, [client, enabled]);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      pollAbort.current?.abort();
    };
  }, []);

  // An access save changes which workspaces list an account as their own.
  useEffect(() => {
    const changed = () => void refresh();
    window.addEventListener("model-connections-changed", changed);
    return () => window.removeEventListener("model-connections-changed", changed);
  }, [refresh]);

  const connect = useCallback(
    async (options?: { onConnected?: (accountId: string | null) => void }) => {
      const recordOutcome = beginModelConnectJourney("codex", "device_code");
      setBusy(true);
      try {
        const start = await client.requestJson<CodexConnectStart>(
          "POST",
          `/v1/organizations/${organizationId}/codex/connect/start`,
          {},
        );
        setPending({ userCode: start.userCode, verificationUri: start.verificationUri });
        window.open(start.verificationUri, "_blank", "noopener,noreferrer");
        pollAbort.current?.abort();
        const controller = new AbortController();
        pollAbort.current = controller;
        // Bounded by the provider's 15-minute device window, like a workspace connect.
        void pollDeviceAuthorization({
          poll: () =>
            client.requestJson<CodexConnectPoll>(
              "POST",
              `/v1/organizations/${organizationId}/codex/connect/poll`,
              { state: start.state },
            ),
          expired: { status: "expired" } as CodexConnectPoll,
          initialIntervalSeconds: Math.max(2, start.intervalSeconds),
          expiresAtMs: Date.now() + 15 * 60_000,
          signal: controller.signal,
        })
          .then(async (result) => {
            if (!result) return;
            // Organization accounts feed every workspace that inherits them, so
            // a confirmed sign-in invalidates every retained Codex list, also
            // when the page was left as it was confirmed. (Leaving earlier
            // stops polling: unmount aborts it and `result` is null.)
            if (result.status === "connected")
              void invalidateSharedQueries(client, ["codex-accounts"]);
            if (controller.signal.aborted || cancelled.current) return;
            setPending(null);
            if (result.status === "expired") {
              recordOutcome("expired");
              toast.error("The code expired before it was used. Try again.");
              return;
            }
            if (result.status === "connected") {
              recordOutcome("connected");
              toast.success(
                `Codex connected for the organization${result.plan ? ` (${planLabel(result.plan, "ChatGPT")})` : ""}`,
              );
              await refresh();
              options?.onConnected?.(
                "accountId" in result && typeof result.accountId === "string"
                  ? result.accountId
                  : null,
              );
            }
          })
          .catch((error) => {
            recordOutcome("outcome_unknown");
            if (controller.signal.aborted || cancelled.current) return;
            setPending(null);
            toast.error("Couldn't confirm the ChatGPT sign-in", {
              description: userErrorText(error),
            });
          });
      } catch (error) {
        recordOutcome("outcome_unknown");
        setPending(null);
        toast.error("Couldn't start the ChatGPT sign-in", { description: userErrorText(error) });
      } finally {
        setBusy(false);
      }
    },
    [client, organizationId, refresh],
  );

  const mutate = async (key: string, operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setWorking(key);
    try {
      await operation();
      await refresh();
      toast.success(success);
    } catch (error) {
      toast.error("Couldn't update Codex", { description: userErrorText(error) });
    } finally {
      setBusy(false);
      setWorking(null);
    }
  };

  const activate = (account: CodexAccount) =>
    mutate(
      `activate:${account.id}`,
      () =>
        client.requestJson(
          "POST",
          `/v1/organizations/${organizationId}/codex/accounts/${account.id}/activate`,
          {},
        ),
      `${codexAccountName(account)} is now the primary account`,
    );

  const setAllocator = (account: CodexAccount, allocatorEnabled: boolean) =>
    mutate(
      `allocator:${account.id}`,
      async () => {
        try {
          return await client.requestJson(
            "PATCH",
            `/v1/organizations/${organizationId}/codex/accounts/${account.id}/allocator`,
            { enabled: allocatorEnabled, expectedVersion: account.allocatorVersion },
          );
        } catch (error) {
          await refresh();
          throw error;
        }
      },
      allocatorEnabled
        ? `${codexAccountName(account)} enabled`
        : `${codexAccountName(account)} disabled`,
    );

  const setExtraCredits = (account: CodexAccount, extraCreditsEnabled: boolean) =>
    mutate(
      `extra-credits:${account.id}`,
      async () => {
        try {
          return await client.requestJson(
            "PATCH",
            `/v1/organizations/${organizationId}/codex/accounts/${account.id}/extra-credits`,
            { enabled: extraCreditsEnabled, expectedVersion: account.extraCreditsVersion ?? 1 },
          );
        } catch (error) {
          await refresh();
          throw error;
        }
      },
      extraCreditsEnabled ? "Extra credit spending on" : "Extra credit spending off",
    );

  const setRotation = (rotationEnabled: boolean) =>
    mutate(
      "rotation",
      () =>
        client.requestJson("PATCH", `/v1/organizations/${organizationId}/codex/settings`, {
          rotationEnabled,
        }),
      rotationEnabled
        ? "New work is spread across the organization's accounts"
        : "New work uses the organization's primary account only",
    );

  /** Throws so the rename prompt can say what to do (API facts go in Technical details). */
  const rename = async (account: CodexAccount, label: string): Promise<void> => {
    setBusy(true);
    setWorking(`rename:${account.id}`);
    try {
      await client.requestJson(
        "PATCH",
        `/v1/organizations/${organizationId}/codex/accounts/${account.id}`,
        { label: label.trim() || null },
      );
      await refresh();
      toast.success("Name saved");
    } catch (error) {
      throw error instanceof Error && error.message
        ? error
        : new Error("Couldn't save the name.", { cause: error });
    } finally {
      setBusy(false);
      setWorking(null);
    }
  };

  /** Throws so the confirm dialog can say what to do (API facts go in Technical details). */
  const disconnect = async (account: CodexAccount): Promise<void> => {
    setBusy(true);
    setWorking(`disconnect:${account.id}`);
    try {
      await client.requestJson(
        "DELETE",
        `/v1/organizations/${organizationId}/codex/accounts/${account.id}`,
        {},
      );
      await refresh();
      toast.success(`Disconnected ${codexAccountName(account)}`);
    } catch (error) {
      throw error instanceof Error && error.message
        ? error
        : new Error(`Couldn't disconnect ${codexAccountName(account)}. Try again.`, {
            cause: error,
          });
    } finally {
      setBusy(false);
      setWorking(null);
    }
  };

  return {
    client,
    organizationId,
    data,
    accounts: data?.accounts ?? [],
    activeAccountId: data?.activeAccountId ?? null,
    rotationEnabled: data?.settings.rotationEnabled ?? false,
    loading,
    loadError,
    busy,
    working,
    pending,
    refresh,
    connect,
    activate,
    setRotation,
    setAllocator,
    setExtraCredits,
    rename,
    disconnect,
  };
}
