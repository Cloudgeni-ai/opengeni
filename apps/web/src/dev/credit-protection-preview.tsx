import { useState } from "react";
import {
  AutoTopUpForm,
  CreditAlertForm,
  type AutoTopUpView,
} from "@/components/organization/credit-protection-forms";

/** Real settings components, sample data only. No Stripe or billing API calls. */
export function CreditProtectionPreview() {
  const search = new URLSearchParams(window.location.search);
  const state = search.get("state") ?? "ready";
  const canManage = state !== "readonly";
  const [message, setMessage] = useState("");
  const settings: AutoTopUpView = {
    enabled: state === "ready" || state === "readonly" || state === "cap",
    thresholdMicros: 10_000_000,
    amountMicros: 25_000_000,
    monthlyCapMicros: 100_000_000,
    spentThisMonthMicros: state === "cap" ? 100_000_000 : 25_000_000,
    status:
      state === "failed"
        ? "payment_failed"
        : state === "cap"
          ? "cap_reached"
          : state === "ready"
            ? "ready"
            : "off",
    paymentMethod: state === "no-card" ? null : { brand: "Visa", last4: "4242" },
  };
  return (
    <>
      <CreditAlertForm
        thresholdMicros={10_000_000}
        canManage={canManage}
        onSave={async (value) => value}
      />
      <AutoTopUpForm
        settings={settings}
        canManage={canManage}
        onSave={async (values) => ({
          ...settings,
          ...values,
          status: values.enabled ? "ready" : "off",
        })}
        onSetupPaymentMethod={async () => {
          setMessage("Preview only. Card setup opens Stripe without making a charge.");
        }}
      />
      {message ? (
        <p role="status" className="text-xs text-fg-muted">
          {message}
        </p>
      ) : null}
    </>
  );
}
