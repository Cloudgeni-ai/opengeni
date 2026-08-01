import { KeyRoundIcon } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { ChatGptMark } from "@/components/chatgpt-mark";
import { cn } from "@/lib/utils";
import type { PickerModelRow } from "@/lib/model-policy";

export type BillingClass = PickerModelRow["billingClass"];

const BILLING_CLASS_ARIA: Record<BillingClass, string> = {
  opengeni_credits: "OpenGeni",
  codex_subscription: "Codex",
  byok: "Bring your own key",
};

/** Compact clipped mark for OpenGeni / Codex / BYOK rails. */
export function BillingClassMark(props: {
  billingClass: BillingClass;
  className?: string;
  /** Defaults to the product rail name for a11y. Pass empty to mark decorative. */
  "aria-label"?: string;
}) {
  // Clip paint: BrandMark’s path transforms can draw outside the box.
  const shell = cn(
    "inline-flex size-3.5 shrink-0 items-center justify-center overflow-hidden text-fg-subtle",
    props.className,
  );
  const mark = "size-3.5";
  const label = props["aria-label"] ?? BILLING_CLASS_ARIA[props.billingClass];
  const decorative = label.length === 0;
  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { role: "img" as const, "aria-label": label };
  if (props.billingClass === "opengeni_credits") {
    return (
      <span className={shell} data-testid="billing-class-icon-opengeni_credits" {...a11y}>
        <BrandMark className={mark} />
      </span>
    );
  }
  if (props.billingClass === "codex_subscription") {
    return (
      <span className={shell} data-testid="billing-class-icon-codex_subscription" {...a11y}>
        <ChatGptMark className={mark} />
      </span>
    );
  }
  return (
    <span className={shell} data-testid="billing-class-icon-byok" {...a11y}>
      <KeyRoundIcon className={mark} aria-hidden />
    </span>
  );
}
