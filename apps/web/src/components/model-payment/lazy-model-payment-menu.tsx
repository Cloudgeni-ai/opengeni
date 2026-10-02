import { Suspense } from "react";

import { ComposerMenuRowsSkeleton, lazyComposerPanel } from "@/components/ui/composer-menu";

/** Loads with the composer's other drill-ins (warmed when "+" is hovered, focused or idle). */
const LazyModelPaymentMenu = lazyComposerPanel(() =>
  import("@/components/model-payment/model-payment-menu").then((module) => module.ModelPaymentMenu),
);

/** The model picker's panel when nothing can run here: how to pay for models. */
export function renderModelPaymentMenu(workspaceId: string) {
  return (
    <Suspense fallback={<ComposerMenuRowsSkeleton rows={5} label="Loading ways to pay" />}>
      <LazyModelPaymentMenu workspaceId={workspaceId} />
    </Suspense>
  );
}
