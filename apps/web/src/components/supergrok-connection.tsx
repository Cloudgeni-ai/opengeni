import {
  useSubscriptionAccountPool,
  subscriptionAccountName,
} from "./models/use-subscription-account-pool";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { trackModelConnection } from "@/lib/analytics-observer";
import { beginModelConnectJourney } from "@/lib/integration-connect-analytics";

import type {
  SuperGrokAccount,
  SuperGrokAccountsResponse,
  SuperGrokAccountScope,
} from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  return subscriptionAccountName(account);
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
  const operations = useMemo(
    () => ({
      load: () =>
        organizationId
          ? client.listOrganizationSuperGrokAccounts(organizationId)
          : client.listSuperGrokAccounts(workspaceId!),
      rotation: (rotationEnabled: boolean) =>
        organizationId
          ? client.setOrganizationSuperGrokRotationSettings(organizationId, { rotationEnabled })
          : client.setSuperGrokRotationSettings(workspaceId!, { rotationEnabled }),
      activate: (account: SuperGrokAccount) =>
        organizationId
          ? client.activateOrganizationSuperGrokAccount(organizationId, account.id)
          : client.activateSuperGrokAccount(workspaceId!, account.id),
      allocator: (account: SuperGrokAccount, enabled: boolean) =>
        organizationId
          ? client.setOrganizationSuperGrokAccountAllocator(organizationId, account.id, {
              enabled,
              expectedVersion: account.allocatorVersion,
            })
          : client.setSuperGrokAccountAllocator(workspaceId!, account.id, {
              enabled,
              expectedVersion: account.allocatorVersion,
            }),
      rename: (account: SuperGrokAccount, label: string | null) =>
        organizationId
          ? client.renameOrganizationSuperGrokAccount(organizationId, account.id, label)
          : client.renameSuperGrokAccount(workspaceId!, account.id, label),
      disconnect: (account: SuperGrokAccount) =>
        organizationId
          ? client.disconnectOrganizationSuperGrokAccount(organizationId, account.id)
          : client.disconnectSuperGrokAccount(workspaceId!, account.id),
    }),
    [client, organizationId, workspaceId],
  );
  const pool = useSubscriptionAccountPool({
    operations,
    client,
    identity: "supergrok:" + (organizationId ?? workspaceId),
    providerName: "SuperGrok",
    organizationId,
    workspaceId,
    canManage,
    enabled: readEnabled,
  });
  const { refresh } = pool;
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingDeviceCode | null>(null);
  const connectEpoch = useRef({
    client,
    workspaceId,
    organizationId,
    readEnabled,
    canManage,
    active: true,
    sequence: 0,
  });
  if (
    connectEpoch.current.client !== client ||
    connectEpoch.current.workspaceId !== workspaceId ||
    connectEpoch.current.organizationId !== organizationId ||
    connectEpoch.current.readEnabled !== readEnabled ||
    connectEpoch.current.canManage !== canManage
  ) {
    connectEpoch.current.active = false;
    connectEpoch.current = {
      client,
      workspaceId,
      organizationId,
      readEnabled,
      canManage,
      active: true,
      sequence: 0,
    };
  }
  const epoch = connectEpoch.current;
  const pollAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    epoch.active = true;
    setPending(null);
    setBusy(false);
    return () => {
      epoch.active = false;
      pollAbort.current?.abort();
      pollAbort.current = null;
    };
  }, [epoch]);

  /** `scope` is "workspace" (shared) or "user" (only the person connecting). */
  const connect = useCallback(
    async (
      scope: Exclude<SuperGrokAccountScope, "organization">,
      options?: { onConnected?: (accountId: string | null) => void },
    ) => {
      if (!epoch.active || !readEnabled || !canManage) return;
      const sequence = ++epoch.sequence;
      const live = () => epoch.active && sequence === epoch.sequence;
      const recordOutcome = workspaceId
        ? trackModelConnection("supergrok", workspaceId)
        : beginModelConnectJourney("supergrok", "device_code");
      setBusy(true);
      try {
        const start = organizationId
          ? await client.organizationSupergrokConnectStart(organizationId)
          : await client.supergrokConnectStart(workspaceId!, scope);
        if (!live()) return;
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
            if (!result || controller.signal.aborted || !live()) return;
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
              if (live()) options?.onConnected?.(result.accountId ?? null);
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
            if (!controller.signal.aborted && live()) {
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
        if (!live()) return;
        recordOutcome("outcome_unknown");
        setPending(null);
        toast.error("Couldn't start the xAI sign-in", { description: userErrorText(error) });
      } finally {
        if (live()) setBusy(false);
      }
    },
    [client, refresh, workspaceId, organizationId, epoch, canManage, readEnabled],
  );

  return {
    ...pool,
    client,
    organizationId,
    workspaceId,
    canManage,
    busy: busy || pool.busy,
    pending,
    connect,
  };
}
