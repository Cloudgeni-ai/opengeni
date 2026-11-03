import { useCallback, useEffect, useRef, useState } from "react";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import {
  apiErrorAdvice,
  apiErrorDetails,
  apiErrorFacts,
  isPermissionDenied,
} from "@opengeni/react/ui/api-error";
import { CREDIT_BALANCE_CHANGED } from "@opengeni/react/app/lib/credit-balance-events";
import { AutoTopUpForm, CreditAlertForm, type AutoTopUpView } from "./credit-protection-forms";
import type { AutoTopUpValues } from "./credit-protection-values";

type AlertSettings = { accountId: string; lowBalanceThresholdMicros: number };
type AutoTopUpSettings = AutoTopUpView & { accountId: string };

/** The billing-only client boundary, shared by the real page and its focused tests. */
export interface CreditProtectionClient {
  getBillingAlertSettings(options: { accountId: string }): Promise<AlertSettings>;
  updateBillingAlertSettings(request: AlertSettings): Promise<AlertSettings>;
  getBillingAutoTopUp(options: { accountId: string }): Promise<AutoTopUpSettings>;
  updateBillingAutoTopUp(
    request: AutoTopUpValues & { accountId: string; idempotencyKey: string },
  ): Promise<AutoTopUpSettings>;
  createBillingAutoTopUpSetupSession(request: {
    accountId: string;
    idempotencyKey: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }>;
}

/** Key this boundary by the full organization-admin identity, not just account ID. */
export function CreditProtectionSettings(props: {
  client: CreditProtectionClient;
  accountId: string;
  canManageAlerts: boolean;
  canManageAutoTopUp: boolean;
  returnUrl: string;
  onNavigate?: (url: string) => void;
}) {
  return (
    <>
      <AlertSettingsSection {...props} />
      <AutoTopUpSettingsSection {...props} />
    </>
  );
}

function AlertSettingsSection(props: {
  client: CreditProtectionClient;
  accountId: string;
  canManageAlerts: boolean;
}) {
  const load = useCallback(
    () => props.client.getBillingAlertSettings({ accountId: props.accountId }),
    [props.client, props.accountId],
  );
  const resource = useBillingSettingsResource(props.accountId, load);
  return (
    <>
      <SettingsLoadFailure title="Couldn't load credit alerts" resource={resource} />
      {resource.data ? (
        <CreditAlertForm
          thresholdMicros={resource.data.lowBalanceThresholdMicros}
          canManage={props.canManageAlerts && !resource.denied}
          onSave={async (lowBalanceThresholdMicros) =>
            (
              await resource.save(() =>
                props.client.updateBillingAlertSettings({
                  accountId: props.accountId,
                  lowBalanceThresholdMicros,
                }),
              )
            ).lowBalanceThresholdMicros
          }
        />
      ) : null}
    </>
  );
}

function AutoTopUpSettingsSection(props: {
  client: CreditProtectionClient;
  accountId: string;
  canManageAutoTopUp: boolean;
  returnUrl: string;
  onNavigate?: (url: string) => void;
}) {
  const load = useCallback(
    () => props.client.getBillingAutoTopUp({ accountId: props.accountId }),
    [props.client, props.accountId],
  );
  // Refresh status, cap reservations and the saved card after Stripe returns.
  const resource = useBillingSettingsResource(props.accountId, load, 30_000);
  const setupKey = useRef<string | null>(null);
  const alive = useRef(false);
  const mayManage = useRef(props.canManageAutoTopUp);
  mayManage.current = props.canManageAutoTopUp && !resource.denied && resource.data !== null;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <>
      <SettingsLoadFailure title="Couldn't load automatic top-up" resource={resource} />
      {resource.data ? (
        <AutoTopUpForm
          settings={resource.data}
          canManage={props.canManageAutoTopUp && !resource.denied}
          onSave={(values, idempotencyKey) =>
            resource.save(() =>
              props.client.updateBillingAutoTopUp({
                ...values,
                accountId: props.accountId,
                idempotencyKey,
              }),
            )
          }
          onSetupPaymentMethod={async () => {
            setupKey.current ??= crypto.randomUUID();
            const result = await props.client.createBillingAutoTopUpSetupSession({
              accountId: props.accountId,
              idempotencyKey: setupKey.current,
              successUrl: props.returnUrl,
              cancelUrl: props.returnUrl,
            });
            if (!alive.current || !mayManage.current) return;
            if (props.onNavigate) props.onNavigate(result.url);
            else window.location.assign(result.url);
          }}
        />
      ) : null}
    </>
  );
}

/** Reads cannot overwrite a newer mutation, including an outcome-unknown mutation. */
function useBillingSettingsResource<T extends { accountId: string }>(
  accountId: string,
  load: () => Promise<T>,
  pollMs?: number,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const alive = useRef(false);
  const sequence = useRef(0);
  const pending = useRef(false);
  const checkAccount = useCallback(
    (result: T) => {
      if (result.accountId !== accountId)
        throw new Error(
          "The billing response did not match this organization. Reload and try again.",
        );
      return result;
    },
    [accountId],
  );
  const refresh = useCallback(async () => {
    if (pending.current) return;
    const current = ++sequence.current;
    try {
      const next = checkAccount(await load());
      if (!alive.current || current !== sequence.current) return;
      setData(next);
      setError(null);
    } catch (failure) {
      if (!alive.current || current !== sequence.current) return;
      const status = apiErrorFacts(failure).status;
      setError(status === 404 ? null : failure);
      // Never retain previously authorized content after revocation or a disabled feature.
      if (isPermissionDenied(failure) || status === 401 || status === 404) setData(null);
    }
  }, [checkAccount, load]);
  useEffect(() => {
    const requests = sequence;
    alive.current = true;
    void refresh();
    const focused = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ accountId: string }>).detail.accountId === accountId) focused();
    };
    window.addEventListener("focus", focused);
    window.addEventListener(CREDIT_BALANCE_CHANGED, changed);
    const timer = pollMs ? window.setInterval(focused, pollMs) : undefined;
    return () => {
      alive.current = false;
      requests.current++;
      window.removeEventListener("focus", focused);
      window.removeEventListener(CREDIT_BALANCE_CHANGED, changed);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [accountId, pollMs, refresh]);

  async function save(write: () => Promise<T>): Promise<T> {
    if (pending.current) throw new Error("Wait for the current change to finish.");
    pending.current = true;
    sequence.current++;
    try {
      const next = checkAccount(await write());
      if (alive.current) {
        setData(next);
        setError(null);
      }
      return next;
    } finally {
      pending.current = false;
    }
  }
  return { data, error, denied: isPermissionDenied(error), refresh, save };
}

function SettingsLoadFailure(props: {
  title: string;
  resource: { error: unknown; denied: boolean; refresh: () => Promise<void> };
}) {
  if (!props.resource.error) return null;
  if (props.resource.denied)
    return (
      <p className="text-xs leading-[18px] text-fg-muted">
        Ask an organization owner for access to billing settings.
      </p>
    );
  return (
    <ErrorMessage
      variant="inline"
      title={props.title}
      announce
      action={<RowButton onClick={() => void props.resource.refresh()}>Try again</RowButton>}
      {...apiErrorDetails(props.resource.error)}
    >
      {apiErrorAdvice(props.resource.error)}
    </ErrorMessage>
  );
}
