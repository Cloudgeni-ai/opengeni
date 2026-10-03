import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type { SubscriptionPoolSettings } from "@opengeni/sdk";
import { ApiError } from "@/api";
import { apiErrorAdvice, userErrorText } from "@/lib/api-error";

export type SubscriptionPoolAccount = {
  id: string;
  subject: string;
  label?: string | null;
  email?: string | null;
  scope: "workspace" | "organization" | "user";
  allocatorVersion: number;
};
export type SubscriptionAccountPoolData<Account extends SubscriptionPoolAccount> = {
  accounts: Account[];
  activeAccountId: string | null;
  settings: SubscriptionPoolSettings;
  source?: "workspace" | "organization" | "user";
  organizationId?: string;
};
export type SubscriptionAccountPoolOperations<Account extends SubscriptionPoolAccount> = {
  load(): Promise<SubscriptionAccountPoolData<Account>>;
  rotation(enabled: boolean): Promise<unknown>;
  activate(account: Account): Promise<unknown>;
  allocator(account: Account, enabled: boolean): Promise<unknown>;
  rename(account: Account, label: string | null): Promise<unknown>;
  disconnect(account: Account): Promise<unknown>;
};
export function subscriptionAccountName(account: SubscriptionPoolAccount) {
  return account.label ?? account.email ?? account.subject;
}

/** The same list, mutations and scope-epoch fencing for every subscription provider. */
export function useSubscriptionAccountPool<Account extends SubscriptionPoolAccount>(input: {
  operations: SubscriptionAccountPoolOperations<Account>;
  identity: string;
  client: object;
  providerName: string;
  organizationId?: string | undefined;
  workspaceId?: string | undefined;
  canManage: boolean;
  enabled?: boolean | undefined;
}) {
  const enabled = input.enabled ?? true;
  type Epoch = { identity: string; client: object; enabled: boolean; active: boolean };
  const epoch = useRef<Epoch>({
    identity: input.identity,
    client: input.client,
    enabled,
    active: true,
  });
  if (
    epoch.current.identity !== input.identity ||
    epoch.current.client !== input.client ||
    epoch.current.enabled !== enabled
  ) {
    epoch.current.active = false;
    epoch.current = { identity: input.identity, client: input.client, enabled, active: true };
  }
  const current = epoch.current;
  const [state, setState] = useState<{
    epoch: Epoch;
    data: SubscriptionAccountPoolData<Account> | null;
    loading: boolean;
    loadError: string | null;
    unavailable: boolean;
  }>(() => ({ epoch: current, data: null, loading: enabled, loadError: null, unavailable: false }));
  const [mutation, setMutation] = useState<{ epoch: Epoch; working: string | null }>({
    epoch: current,
    working: null,
  });
  const loadSequence = useRef(0);
  const pendingMutation = useRef<{ epoch: Epoch; token: object } | null>(null);
  const refresh = useCallback(async () => {
    if (!current.enabled || !current.active) return;
    const sequence = ++loadSequence.current;
    try {
      const data = await input.operations.load();
      if (current.active && sequence === loadSequence.current)
        setState({ epoch: current, data, loading: false, loadError: null, unavailable: false });
    } catch (error) {
      if (!current.active || sequence !== loadSequence.current) return;
      const unavailable =
        (error instanceof OpenGeniApiError || error instanceof ApiError) && error.status === 404;
      setState({
        epoch: current,
        data: null,
        loading: false,
        loadError: unavailable ? null : apiErrorAdvice(error),
        unavailable,
      });
    }
  }, [current, input.operations]);
  useEffect(() => {
    current.active = true;
    setState({
      epoch: current,
      data: null,
      loading: current.enabled,
      loadError: null,
      unavailable: false,
    });
    void refresh();
    return () => {
      current.active = false;
    };
  }, [current, refresh]);
  const mutate = useCallback(
    async (key: string, operation: () => Promise<unknown>, success: string, propagate = false) => {
      if (!current.active || !input.canManage) {
        if (propagate) throw new Error("You can no longer manage this account.");
        return;
      }
      if (pendingMutation.current?.epoch === current) {
        if (propagate)
          throw new Error("An account change is already in progress. Wait for it to finish.");
        return;
      }
      const token = {};
      pendingMutation.current = { epoch: current, token };
      setMutation({ epoch: current, working: key });
      try {
        await operation();
        if (!current.active) return;
        await refresh();
        if (current.active) toast.success(success);
      } catch (error) {
        if (!current.active) return;
        if (propagate)
          throw error instanceof Error
            ? error
            : new Error("Couldn't update the account.", { cause: error });
        toast.error(`Couldn't update ${input.providerName}`, { description: userErrorText(error) });
      } finally {
        if (pendingMutation.current?.token === token) {
          pendingMutation.current = null;
          if (current.active) setMutation({ epoch: current, working: null });
        }
      }
    },
    [current, input.canManage, input.providerName, refresh],
  );
  const data = state.epoch === current ? state.data : null;
  const inherited = !input.organizationId && data?.source === "organization";
  const canManageAccounts = input.canManage && !inherited;
  return {
    data,
    accounts: data?.accounts ?? [],
    inherited,
    canManageAccounts,
    activeAccountId: data?.activeAccountId ?? null,
    rotationEnabled: data?.settings.rotationEnabled ?? false,
    loading: state.epoch === current ? state.loading : enabled,
    loadError: state.epoch === current ? state.loadError : null,
    unavailable: state.epoch === current ? state.unavailable : false,
    busy: mutation.epoch === current && mutation.working !== null,
    working: mutation.epoch === current ? mutation.working : null,
    refresh,
    setRotation: (rotationEnabled: boolean) =>
      canManageAccounts
        ? mutate(
            "rotation",
            () => input.operations.rotation(rotationEnabled),
            rotationEnabled
              ? `New work is spread across ${input.providerName} accounts`
              : `New work uses the primary ${input.providerName} account only`,
          )
        : Promise.resolve(),
    activate: (account: Account) =>
      canManageAccounts
        ? mutate(
            `activate:${account.id}`,
            () => input.operations.activate(account),
            `${subscriptionAccountName(account)} is now the primary account`,
          )
        : Promise.resolve(),
    setAllocator: (account: Account, allocatorEnabled: boolean) =>
      canManageAccounts
        ? mutate(
            `allocator:${account.id}`,
            () => input.operations.allocator(account, allocatorEnabled),
            allocatorEnabled
              ? `${subscriptionAccountName(account)} is used for new work again`
              : `${subscriptionAccountName(account)} won't be used for new work`,
          )
        : Promise.resolve(),
    rename: (account: Account, label: string) =>
      canManageAccounts
        ? mutate(
            `rename:${account.id}`,
            () => input.operations.rename(account, label.trim() || null),
            "Name saved",
            true,
          )
        : Promise.reject(new Error("Manage this account in its owning scope.")),
    disconnect: (account: Account) =>
      canManageAccounts
        ? mutate(
            `disconnect:${account.id}`,
            () => input.operations.disconnect(account),
            `Disconnected ${subscriptionAccountName(account)}`,
            true,
          )
        : Promise.reject(new Error("Manage this account in its owning scope.")),
  };
}
