import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { trackModelConnection } from "@/lib/analytics-observer";

import type {
  SuperGrokAccount,
  SuperGrokAccountsResponse,
  SuperGrokAccountScope,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SubscriptionDeviceCodePanel } from "@/components/subscription-device-code-panel";

import { ApiError } from "@/api";
import { apiErrorAdvice, userErrorText } from "@/lib/api-error";
import { pollSuperGrokDeviceLogin } from "./supergrok-device-poll";

// SuperGrok (xAI) subscriptions for Settings > Models at workspace and
// organization scope: the data and every mutation. Rows, the account page and
// the Connect page live in components/models/supergrok-models.tsx.

type PendingDeviceCode = {
  userCode: string;
  verificationUri: string;
};

export function SuperGrokDeviceCodePanel(props: PendingDeviceCode) {
  return <SubscriptionDeviceCodePanel {...props} provider="supergrok" />;
}

export function superGrokAccountName(account: SuperGrokAccount): string {
  return account.label ?? account.email ?? account.subject;
}

type SubscriptionScope =
  | { workspaceId: string; organizationId?: never; canManage: boolean }
  | { organizationId: string; workspaceId?: never; canManage: boolean };

/** The deployment has SuperGrok turned off: the API answers 404 for the whole family. */
function deploymentDisabled(error: unknown): boolean {
  return (
    (error instanceof OpenGeniApiError || error instanceof ApiError) &&
    (error as { status: number }).status === 404
  );
}

export type SuperGrokSubscriptions = ReturnType<typeof useSuperGrokSubscriptions>;

export function useSuperGrokSubscriptions({
  workspaceId,
  organizationId,
  canManage,
  client,
  enabled: readEnabled = true,
}: SubscriptionScope & {
  client: OpenGeniBrowserClient;
  /** False for people who can't read these accounts: nothing is read. */
  enabled?: boolean;
}) {
  const [data, setData] = useState<SuperGrokAccountsResponse | null>(null);
  const [loading, setLoading] = useState(readEnabled);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** SuperGrok is off for this deployment: the page doesn't show it at all. */
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDeviceCode | null>(null);
  const cancelled = useRef(false);
  const pollAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!readEnabled) return;
    try {
      setData(
        organizationId
          ? await client.listOrganizationSuperGrokAccounts(organizationId)
          : await client.listSuperGrokAccounts(workspaceId!),
      );
      setLoadError(null);
      setUnavailable(false);
    } catch (error) {
      setData(null);
      if (deploymentDisabled(error)) {
        setUnavailable(true);
        setLoadError(null);
      } else {
        // Shown under "Couldn't load ..." as what to do; never the raw API message.
        setLoadError(apiErrorAdvice(error));
      }
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId, organizationId, readEnabled]);

  useEffect(() => {
    cancelled.current = false;
    setLoading(readEnabled);
    void refresh();
    return () => {
      cancelled.current = true;
      pollAbort.current?.abort();
      pollAbort.current = null;
    };
  }, [refresh, readEnabled]);

  /** `scope` is "workspace" (shared) or "user" (only the person connecting). */
  const connect = useCallback(
    async (
      scope: Exclude<SuperGrokAccountScope, "organization">,
      options?: { onConnected?: (accountId: string | null) => void },
    ) => {
      const recordOutcome = workspaceId ? trackModelConnection("supergrok", workspaceId) : () => {};
      setBusy(true);
      try {
        const start = organizationId
          ? await client.organizationSupergrokConnectStart(organizationId)
          : await client.supergrokConnectStart(workspaceId!, scope);
        setPending({
          userCode: start.userCode,
          verificationUri: start.verificationUri,
        });
        window.open(
          start.verificationUriComplete ?? start.verificationUri,
          "_blank",
          "noopener,noreferrer",
        );
        pollAbort.current?.abort();
        const controller = new AbortController();
        pollAbort.current = controller;
        void pollSuperGrokDeviceLogin({
          poll: () =>
            organizationId
              ? client.organizationSupergrokConnectPoll(organizationId, start.state)
              : client.supergrokConnectPoll(workspaceId!, start.state),
          initialIntervalSeconds: start.intervalSeconds,
          expiresAtMs: Date.now() + start.expiresInSeconds * 1_000,
          signal: controller.signal,
        })
          .then(async (result) => {
            if (!result || controller.signal.aborted || cancelled.current) return;
            setPending(null);
            if (result.status === "connected") {
              recordOutcome("connected");
              toast.success(
                result.scope === "organization"
                  ? "SuperGrok connected for the organization"
                  : result.scope === "workspace"
                    ? "SuperGrok connected for the workspace"
                    : "Your private SuperGrok account is connected",
              );
              await refresh();
              options?.onConnected?.(result.accountId ?? null);
              return;
            }
            recordOutcome(result.status === "expired" ? "expired" : "denied");
            toast.error(
              result.status === "expired"
                ? "The xAI code expired before it was used. Try again."
                : "The xAI sign-in was declined",
            );
          })
          .catch((error) => {
            recordOutcome("outcome_unknown");
            if (!controller.signal.aborted && !cancelled.current) {
              setPending(null);
              toast.error("Couldn't confirm the xAI sign-in", {
                description: userErrorText(error),
              });
            }
          })
          .finally(() => {
            if (pollAbort.current === controller) pollAbort.current = null;
          });
      } catch (error) {
        recordOutcome("outcome_unknown");
        setPending(null);
        toast.error("Couldn't start the xAI sign-in", { description: userErrorText(error) });
      } finally {
        setBusy(false);
      }
    },
    [client, refresh, workspaceId, organizationId],
  );

  const mutate = useCallback(
    async (key: string, operation: () => Promise<unknown>, success: string) => {
      setBusy(true);
      setWorking(key);
      try {
        await operation();
        await refresh();
        toast.success(success);
      } catch (error) {
        toast.error("Couldn't update SuperGrok", { description: userErrorText(error) });
      } finally {
        setBusy(false);
        setWorking(null);
      }
    },
    [refresh],
  );

  const setRotation = (rotationEnabled: boolean) =>
    mutate(
      "rotation",
      () =>
        organizationId
          ? client.setOrganizationSuperGrokRotationSettings(organizationId, { rotationEnabled })
          : client.setSuperGrokRotationSettings(workspaceId!, { rotationEnabled }),
      rotationEnabled
        ? "New work is spread across SuperGrok accounts"
        : "New work uses the primary SuperGrok account only",
    );

  const activate = (account: SuperGrokAccount) =>
    mutate(
      `activate:${account.id}`,
      () =>
        organizationId
          ? client.activateOrganizationSuperGrokAccount(organizationId, account.id)
          : client.activateSuperGrokAccount(workspaceId!, account.id),
      `${superGrokAccountName(account)} is now the primary account`,
    );

  const setAllocator = (account: SuperGrokAccount, enabled: boolean) =>
    mutate(
      `allocator:${account.id}`,
      () =>
        organizationId
          ? client.setOrganizationSuperGrokAccountAllocator(organizationId, account.id, {
              enabled,
              expectedVersion: account.allocatorVersion,
            })
          : client.setSuperGrokAccountAllocator(workspaceId!, account.id, {
              enabled,
              expectedVersion: account.allocatorVersion,
            }),
      enabled
        ? `${superGrokAccountName(account)} is used for new work again`
        : `${superGrokAccountName(account)} won't be used for new work`,
    );

  /** Throws so the rename prompt can say what to do (API facts go in Technical details). */
  const rename = async (account: SuperGrokAccount, label: string): Promise<void> => {
    setBusy(true);
    setWorking(`rename:${account.id}`);
    try {
      await (organizationId
        ? client.renameOrganizationSuperGrokAccount(
            organizationId,
            account.id,
            label.trim() || null,
          )
        : client.renameSuperGrokAccount(workspaceId!, account.id, label.trim() || null));
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
  const disconnect = async (account: SuperGrokAccount): Promise<void> => {
    setBusy(true);
    setWorking(`disconnect:${account.id}`);
    try {
      await (organizationId
        ? client.disconnectOrganizationSuperGrokAccount(organizationId, account.id)
        : client.disconnectSuperGrokAccount(workspaceId!, account.id));
      await refresh();
      toast.success(`Disconnected ${superGrokAccountName(account)}`);
    } catch (error) {
      throw error instanceof Error && error.message
        ? error
        : new Error(`Couldn't disconnect ${superGrokAccountName(account)}. Try again.`, {
            cause: error,
          });
    } finally {
      setBusy(false);
      setWorking(null);
    }
  };

  const accounts = data?.accounts ?? [];
  const inherited = !organizationId && data?.source === "organization";
  return {
    client,
    organizationId,
    workspaceId,
    canManage,
    data,
    accounts,
    /** Workspace page showing the organization's accounts: read-only here. */
    inherited,
    canManageAccounts: canManage && !inherited,
    activeAccountId: data?.activeAccountId ?? null,
    rotationEnabled: data?.settings.rotationEnabled ?? false,
    loading,
    loadError,
    unavailable,
    busy,
    working,
    pending,
    refresh,
    connect,
    setRotation,
    activate,
    setAllocator,
    rename,
    disconnect,
  };
}
