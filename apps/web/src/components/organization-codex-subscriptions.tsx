import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
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

// The organization's shared Codex (ChatGPT) accounts: the data and every
// mutation. Organization settings > Models presents them with the same rows
// and account page anatomy as a workspace.

export type OrganizationCodexSubscriptions = ReturnType<typeof useOrganizationCodexSubscriptions>;

export function useOrganizationCodexSubscriptions({
  organizationId,
  client,
}: {
  organizationId: string;
  client: OpenGeniBrowserClient;
}) {
  const [data, setData] = useState<OrganizationCodexAccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    userCode: string;
    verificationUri: string;
  } | null>(null);
  const cancelled = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await client.requestJson<OrganizationCodexAccountsResponse>(
        "GET",
        `/v1/organizations/${organizationId}/codex/accounts`,
      );
      if (!cancelled.current) setData(result);
    } catch (error) {
      if (cancelled.current) return;
      setData(null);
      setLoadError(error instanceof Error ? error.message : "Failed to load subscriptions");
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, [client, organizationId]);

  useEffect(() => {
    cancelled.current = false;
    setLoading(true);
    void refresh();
    return () => {
      cancelled.current = true;
      pollAbort.current?.abort();
    };
  }, [refresh]);

  const connect = useCallback(
    async (options?: { onConnected?: (accountId: string | null) => void }) => {
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
            if (!result || controller.signal.aborted || cancelled.current) return;
            setPending(null);
            if (result.status === "expired") {
              toast.error("The code expired before it was used. Try again.");
              return;
            }
            if (result.status === "connected") {
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
            if (controller.signal.aborted || cancelled.current) return;
            setPending(null);
            toast.error(
              error instanceof Error ? error.message : "Couldn't confirm the ChatGPT sign-in",
            );
          });
      } catch (error) {
        setPending(null);
        toast.error(error instanceof Error ? error.message : "Couldn't start the ChatGPT sign-in");
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
      toast.error(error instanceof Error ? error.message : "Couldn't update Codex");
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

  /** Throws with a user-facing message so the prompt can show it. */
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
      throw new Error(
        error instanceof Error && error.message ? error.message : "Couldn't save the name.",
        { cause: error },
      );
    } finally {
      setBusy(false);
      setWorking(null);
    }
  };

  /** Throws with a user-facing message so the confirm dialog can show it. */
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
      throw new Error(
        error instanceof Error && error.message
          ? error.message
          : `Couldn't disconnect ${codexAccountName(account)}. Try again.`,
        { cause: error },
      );
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
    rename,
    disconnect,
  };
}
