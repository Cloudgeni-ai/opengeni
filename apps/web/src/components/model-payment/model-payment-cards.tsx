import { BillingClassMark } from "@opengeni/react";

import { PAYMENT_MARKS } from "@/components/model-payment/model-payment-choice";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import type { ModelPaymentOption, ModelPaymentOptionId } from "@/lib/model-payment";

/**
 * The headline ways to pay (Opengeni credits and the ChatGPT plan) as choice
 * cards, for a step that asks first and acts below: the same options, words
 * and unavailable reasons as the rows.
 */
export function ModelPaymentCards({
  options,
  value,
  onValueChange,
  label = "How do you want to pay for models?",
}: {
  options: readonly ModelPaymentOption[];
  value: ModelPaymentOptionId | null;
  onValueChange: (value: ModelPaymentOptionId) => void;
  label?: string;
}) {
  return (
    <ChoiceCards
      value={value ?? ""}
      onValueChange={(next) => onValueChange(next as ModelPaymentOptionId)}
      aria-label={label}
    >
      {options.map((option) => (
        <ChoiceCard
          key={option.id}
          value={option.id}
          title={option.title}
          description={option.description}
          icon={
            <BillingClassMark
              billingClass={PAYMENT_MARKS[option.id]}
              aria-label=""
              className="size-4"
            />
          }
          meta={option.meta}
          disabled={option.state !== "available"}
          disabledReason={option.reason}
        />
      ))}
    </ChoiceCards>
  );
}
