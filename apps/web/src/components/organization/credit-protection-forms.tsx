import { useEffect, useRef, useState } from "react";
import { TextInput } from "@opengeni/react/ui/field";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { Section } from "@opengeni/react/ui/section";
import { SettingRow, SettingRowGroup, useSettingRowControl } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { dollarsInputValue, formatBudget, parseDollars } from "@/lib/usage-allowances";
import {
  autoTopUpDraft,
  parseAutoTopUpDraft,
  sameAutoTopUpValues,
  type AutoTopUpValues,
} from "./credit-protection-values";

function DollarsInput(props: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const field = useSettingRowControl();
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-fg-subtle"
      >
        $
      </span>
      <TextInput
        id={field?.controlId}
        aria-label={`${props.label} (USD)`}
        aria-describedby={field?.describedBy}
        aria-invalid={field?.invalid || undefined}
        name={props.name}
        inputMode="decimal"
        autoComplete="off"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        disabled={props.disabled}
        className="h-8 w-32 pl-6 tabular-nums pointer-coarse:h-11"
      />
    </div>
  );
}

/** Key the form by organization identity, so drafts never cross accounts. */
export function CreditAlertForm(props: {
  thresholdMicros: number;
  canManage: boolean;
  onSave: (thresholdMicros: number) => Promise<number>;
}) {
  const [saved, setSaved] = useState(props.thresholdMicros);
  const [amount, setAmount] = useState(() => dollarsInputValue(props.thresholdMicros));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const live = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const micros = parseDollars(amount);
  const invalid = micros === null || micros <= 0;
  async function save() {
    if (!props.canManage || pending.current || invalid || micros === saved) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await props.onSave(micros);
      if (!live.current) return;
      setSaved(next);
      setAmount(dollarsInputValue(next));
      setMessage("Alert threshold saved.");
    } catch (failure) {
      if (live.current) setError(userErrorText(failure, "Couldn't save the alert threshold."));
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <Section
      title="Credit alerts"
      description="Owners and admins are notified when credits run low, run out, or spending rises unusually."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <SettingRow
          label="Notify below"
          description="Uses credits available for any model. Model-specific promotions don't count."
          error={props.canManage && invalid ? "Enter an amount above $0." : undefined}
          controlWidth="auto"
          control={
            props.canManage ? (
              <DollarsInput
                label="Notify below"
                name="credit-alert-threshold"
                value={amount}
                onChange={(value) => {
                  setAmount(value);
                  setMessage(null);
                }}
                disabled={busy}
              />
            ) : (
              <span className="text-sm tabular-nums text-fg">{formatBudget(saved)}</span>
            )
          }
        />
        {props.canManage ? (
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
            <FormMessage error={error} message={message} />
            <RowButton
              type="submit"
              variant="default"
              disabled={busy || invalid || micros === saved}
            >
              {busy ? "Saving…" : "Save alert threshold"}
            </RowButton>
          </div>
        ) : null}
      </form>
    </Section>
  );
}

export type AutoTopUpView = AutoTopUpValues & {
  spentThisMonthMicros: number;
  status:
    | "off"
    | "ready"
    | "payment_method_required"
    | "payment_failed"
    | "cap_reached"
    | "processing";
  paymentMethod: { brand: string; last4: string } | null;
};

/** Owns the draft only. Stripe and authority stay in the API-backed controller. */
export function AutoTopUpForm(props: {
  settings: AutoTopUpView;
  canManage: boolean;
  onSave: (values: AutoTopUpValues, idempotencyKey: string) => Promise<AutoTopUpView>;
  onSetupPaymentMethod: () => Promise<void>;
}) {
  const [saved, setSaved] = useState(props.settings);
  const [draft, setDraft] = useState(() => autoTopUpDraft(props.settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const live = useRef(false);
  const pending = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const parsed = parseAutoTopUpDraft(draft);
  // Disabling must remain possible even if an unfinished input is invalid.
  const next = !draft.enabled ? { ...saved, enabled: false } : parsed.values;
  const changed = next !== null && !sameAutoTopUpValues(next, saved);
  const needsCard = draft.enabled && !saved.paymentMethod;

  async function save() {
    if (!props.canManage || pending.current || !next || !changed || needsCard) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    const values: AutoTopUpValues = {
      enabled: next.enabled,
      thresholdMicros: next.thresholdMicros,
      amountMicros: next.amountMicros,
      monthlyCapMicros: next.monthlyCapMicros,
    };
    const fingerprint = JSON.stringify(values);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const result = await props.onSave(values, attempt.current.key);
      if (!live.current) return;
      setSaved(result);
      setDraft(autoTopUpDraft(result));
      attempt.current = null;
      setMessage(result.enabled ? "Automatic top-up saved." : "Automatic top-up is off.");
    } catch (failure) {
      if (live.current) setError(userErrorText(failure, "Couldn't save automatic top-up."));
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }

  async function setup() {
    if (!props.canManage || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await props.onSetupPaymentMethod();
    } catch (failure) {
      if (live.current) setError(userErrorText(failure, "Couldn't open payment settings."));
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }

  const statusMessage =
    saved.status === "payment_failed"
      ? "Automatic top-up is paused because a payment failed. Update your card, then turn it on again."
      : saved.status === "cap_reached"
        ? "The monthly limit is reached. Add credits manually or increase the limit."
        : saved.status === "processing"
          ? "A top-up is being processed. Turning this off won't cancel a payment already in progress."
          : null;
  return (
    <Section
      title="Automatic top-up"
      description="Add credits from a saved card before they run out."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {statusMessage ? (
          <p role="status" className="pt-4 text-xs leading-[18px] text-fg-muted">
            {statusMessage}
          </p>
        ) : null}
        <SettingRowGroup>
          <SettingRow
            label="Top up automatically"
            controlWidth="compact"
            control={
              props.canManage ? (
                <Switch
                  checked={draft.enabled}
                  pending={busy}
                  onCheckedChange={(enabled) => {
                    setDraft((previous) => ({ ...previous, enabled }));
                    setMessage(null);
                  }}
                />
              ) : (
                <span className="text-sm text-fg">{saved.enabled ? "On" : "Off"}</span>
              )
            }
          >
            {draft.enabled ? (
              <>
                {(
                  [
                    ["threshold", "When credits fall below", "Top-up threshold", undefined],
                    ["amount", "Add each time", "Top-up amount", "Minimum $5."],
                    [
                      "monthlyCap",
                      "Monthly limit",
                      "Monthly top-up limit",
                      "Resets on the 1st at midnight UTC.",
                    ],
                  ] as const
                ).map(([field, label, inputLabel, description]) => (
                  <SettingRow
                    key={field}
                    label={label}
                    description={description}
                    error={props.canManage ? parsed.errors[field] : undefined}
                    controlWidth="auto"
                    control={
                      props.canManage ? (
                        <DollarsInput
                          label={inputLabel}
                          name={`auto-topup-${field}`}
                          value={draft[field]}
                          disabled={busy}
                          onChange={(value) => {
                            setDraft((previous) => ({ ...previous, [field]: value }));
                            setMessage(null);
                          }}
                        />
                      ) : (
                        <span className="text-sm tabular-nums text-fg">
                          {formatBudget(
                            field === "threshold"
                              ? saved.thresholdMicros
                              : field === "amount"
                                ? saved.amountMicros
                                : saved.monthlyCapMicros,
                          )}
                        </span>
                      )
                    }
                  />
                ))}
                <SettingRow
                  label="Payment method"
                  description={
                    saved.paymentMethod
                      ? `${saved.paymentMethod.brand} ending in ${saved.paymentMethod.last4}`
                      : "Save a card in Stripe before turning this on."
                  }
                  controlWidth="auto"
                  control={
                    props.canManage && saved.paymentMethod ? (
                      <RowButton type="button" onClick={() => void setup()} disabled={busy}>
                        Update card
                      </RowButton>
                    ) : undefined
                  }
                />
              </>
            ) : null}
          </SettingRow>
        </SettingRowGroup>
        {draft.enabled ? (
          <p className="pb-3 text-xs leading-[18px] text-fg-muted">
            {formatBudget(saved.spentThisMonthMicros)} topped up this month.
          </p>
        ) : null}
        {props.canManage ? (
          <>
            {draft.enabled && parsed.values && !needsCard ? (
              <p className="max-w-prose pb-3 text-xs leading-[18px] text-fg-muted">
                By saving, you authorize Opengeni to charge your saved card{" "}
                {formatBudget(parsed.values.amountMicros)} when credits fall below{" "}
                {formatBudget(parsed.values.thresholdMicros)}, up to{" "}
                {formatBudget(parsed.values.monthlyCapMicros)} a month. Turn this off at any time.
              </p>
            ) : null}
            {draft.enabled ||
            saved.enabled ||
            error ||
            message ||
            saved.status === "payment_failed" ? (
              <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
                <FormMessage error={error} message={message} />
                {saved.status === "payment_failed" && !draft.enabled ? (
                  <RowButton
                    type="button"
                    variant="default"
                    onClick={() => void setup()}
                    disabled={busy}
                  >
                    {busy ? "Opening Stripe…" : "Update card"}
                  </RowButton>
                ) : needsCard ? (
                  <RowButton
                    type="button"
                    variant="default"
                    onClick={() => void setup()}
                    disabled={busy}
                  >
                    {busy ? "Opening Stripe…" : "Set up card"}
                  </RowButton>
                ) : (
                  <RowButton type="submit" variant="default" disabled={busy || !changed || !next}>
                    {busy
                      ? "Saving…"
                      : !draft.enabled && saved.enabled
                        ? "Turn off automatic top-up"
                        : draft.enabled && !saved.enabled
                          ? "Turn on automatic top-up"
                          : "Save automatic top-up"}
                  </RowButton>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </form>
    </Section>
  );
}

function FormMessage(props: { error: string | null; message: string | null }) {
  return props.error ? (
    <p role="alert" className="min-w-0 flex-1 text-xs leading-[18px] text-danger">
      {props.error}
    </p>
  ) : props.message ? (
    <p role="status" className="min-w-0 flex-1 text-xs leading-[18px] text-fg-muted">
      {props.message}
    </p>
  ) : (
    <span />
  );
}
