/** Web compatibility export; the canonical rail mark lives in the React SDK. */
import {
  BillingClassMark as SharedBillingClassMark,
  type ModelPolicyPickerGroupPresentation,
} from "@opengeni/react";
import type { ComponentProps } from "react";
import { BrandMark } from "./brand-mark";

/** First-party branding is explicit; embedded package defaults stay neutral. */
export const openGeniGroupPresentation: ModelPolicyPickerGroupPresentation = {
  opengeni_credits: { label: "Opengeni", icon: <BrandMark /> },
};

export function BillingClassMark(props: ComponentProps<typeof SharedBillingClassMark>) {
  return (
    <SharedBillingClassMark
      {...props}
      presentation={
        props.billingClass === "opengeni_credits"
          ? {
              ...openGeniGroupPresentation.opengeni_credits,
              ...props.presentation,
              label: props.presentation?.label ?? openGeniGroupPresentation.opengeni_credits?.label,
              icon:
                props.presentation?.icon === undefined
                  ? openGeniGroupPresentation.opengeni_credits?.icon
                  : props.presentation.icon,
            }
          : props.presentation
      }
    />
  );
}
export type { PickerBillingClass as BillingClass } from "@opengeni/react";
