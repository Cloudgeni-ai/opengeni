import { useEffect, useRef, useState } from "react";
import { TextInput } from "@opengeni/react/ui/field";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { Section } from "@opengeni/react/ui/section";
import { SettingRow, SettingRowGroup, useSettingRowControl } from "@opengeni/react/ui/setting-row";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { dollarsInputValue, formatBudget, parseDollars } from "@/lib/usage-allowances";
import {
  autoTopUpDraft,
  parseAutoTopUpDraft,
  reconcileAutoTopUpDraft,
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
  const savedRef = useRef(props.thresholdMicros);
  useEffect(() => {
    const previous = savedRef.current;
    setAmount((current) =>
      parseDollars(current) === previous ? dollarsInputValue(props.thresholdMicros) : current,
    );
    savedRef.current = props.thresholdMicros;
    setSaved(props.thresholdMicros);
  }, [props.thresholdMicros]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const micros = parseDollars(amount);
  const invalid = micros === null || micros < 0;
  async function save() {
    if (!props.canManage || pending.current || invalid || micros === saved) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await props.onSave(micros);
      if (!live.current) return;
      savedRef.current = next;
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
          description="Uses general credits, excluding model promotions. $0 turns off low-balance warnings."
          error={props.canManage && invalid ? "Enter $0 or more." : undefined}
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

function sameAutoTopUpView(a: AutoTopUpView, b: AutoTopUpView): boolean {
  return (
    sameAutoTopUpValues(a, b) &&
    a.spentThisMonthMicros === b.spentThisMonthMicros &&
    a.status === b.status &&
    a.paymentMethod?.brand === b.paymentMethod?.brand &&
    a.paymentMethod?.last4 === b.paymentMethod?.last4
  );
}

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
  const [unconfirmed, setUnconfirmed] = useState(false);
  const live = useRef(false);
  const pending = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const savedRef = useRef(props.settings);
  const receivedRef = useRef(props.settings);
  useEffect(() => {
    // An equivalent parent render is not a refresh and must not roll back a
    // newer save result. Controllers update their snapshot after every save.
    if (sameAutoTopUpView(receivedRef.current, props.settings)) return;
    receivedRef.current = props.settings;
    const previous = savedRef.current;
    setDraft((current) => reconcileAutoTopUpDraft(current, previous, props.settings));
    savedRef.current = props.settings;
    setSaved(props.settings);
    if (!sameAutoTopUpView(previous, props.settings)) setMessage(null);
  }, [props.settings]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const parsed = parseAutoTopUpDraft(draft);
  const capBelowReserved =
    parsed.values !== null && parsed.values.monthlyCapMicros < saved.spentThisMonthMicros;
  if (capBelowReserved)
    parsed.errors.monthlyCap = "The limit cannot be below charges and reservations this month.";
  // Disabling must remain possible even if an unfinished input is invalid.
  const next = !draft.enabled
    ? { ...saved, enabled: false }
    : capBelowReserved
      ? null
      : parsed.values;
  const changed = next !== null && !sameAutoTopUpValues(next, saved);
  const needsCard = draft.enabled && !saved.paymentMethod;

  async function save(explicit?: AutoTopUpValues) {
    const requested = explicit ?? next;
    if (
      !props.canManage ||
      pending.current ||
      !requested ||
      (!unconfirmed && sameAutoTopUpValues(requested, saved)) ||
      (requested.enabled && !saved.paymentMethod)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    const values: AutoTopUpValues = {
      enabled: requested.enabled,
      thresholdMicros: requested.thresholdMicros,
      amountMicros: requested.amountMicros,
      monthlyCapMicros: requested.monthlyCapMicros,
    };
    const fingerprint = JSON.stringify(values);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const result = await props.onSave(values, attempt.current.key);
      if (!live.current) return;
      savedRef.current = result;
      setSaved(result);
      setDraft(autoTopUpDraft(result));
      attempt.current = null;
      setUnconfirmed(false);
      setMessage(result.enabled ? "Automatic top-up saved." : "Automatic top-up is off.");
    } catch (failure) {
      if (live.current) {
        setUnconfirmed(true);
        setError(
          userErrorText(
            failure,
            "The change wasn't confirmed. Retry or turn automatic top-up off.",
          ),
        );
      }
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
            controlWidth="auto"
            control={
              props.canManage ? (
                saved.enabled || unconfirmed ? (
                  <RowButton
                    type="button"
                    disabled={busy}
                    onClick={() => void save({ ...saved, enabled: false })}
                  >
                    Turn off automatic top-up
                  </RowButton>
                ) : (
                  <RowButton
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDraft((previous) =>
                        draft.enabled ? autoTopUpDraft(saved) : { ...previous, enabled: true },
                      );
                      setMessage(null);
                    }}
                  >
                    {draft.enabled ? "Cancel setup" : "Set up"}
                  </RowButton>
                )
              ) : (
                <span className="text-sm text-fg">{saved.enabled ? "On" : "Off"}</span>
              )
            }
          >
            {draft.enabled ? (
              <>
                {(
                  [
                    [
                      "threshold",
                      "When credits fall below",
                      "Credits outside your monthly plan, excluding model promotions.",
                    ],
                    ["amount", "Add each time", "Minimum $5, plus applicable tax."],
                    ["monthlyCap", "Monthly limit", "Per UTC calendar month, including tax."],
                  ] as const
                ).map(([field, label, description]) => (
                  <SettingRow
                    key={field}
                    label={label}
                    description={description}
                    error={props.canManage ? parsed.errors[field] : undefined}
                    controlWidth="auto"
                    control={
                      props.canManage ? (
                        <DollarsInput
                          label={label}
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
            {formatBudget(saved.spentThisMonthMicros)} used this month, including pending charges
            and tax.
          </p>
        ) : null}
        {props.canManage ? (
          <>
            {draft.enabled && parsed.values && !needsCard ? (
              <p className="max-w-prose pb-3 text-xs leading-[18px] text-fg-muted">
                By saving, you authorize Opengeni to charge your saved card off-session for{" "}
                {formatBudget(parsed.values.amountMicros)} of credits plus applicable tax when
                credits fall below {formatBudget(parsed.values.thresholdMicros)}, up to{" "}
                {formatBudget(parsed.values.monthlyCapMicros)} total per UTC month. Turn this off at
                any time.
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
                ) : draft.enabled || saved.enabled || unconfirmed ? (
                  <RowButton
                    type="submit"
                    variant="default"
                    disabled={busy || (!changed && !unconfirmed) || !next}
                  >
                    {busy
                      ? "Saving…"
                      : !draft.enabled && saved.enabled
                        ? "Turn off automatic top-up"
                        : draft.enabled && !saved.enabled
                          ? "Turn on automatic top-up"
                          : "Save automatic top-up"}
                  </RowButton>
                ) : null}
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
